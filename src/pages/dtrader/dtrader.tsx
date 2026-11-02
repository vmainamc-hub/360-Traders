import React from 'react';
import { observer } from 'mobx-react-lite';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import { getDerivAuthContext } from '@/utils/deriv-auth-context';

import './dtrader.css';

/**
 * Native DTrader.
 * Replaces the old iframe (which depended on a third-party host and passed the
 * login token in a URL). It talks to Deriv directly, the same way the other
 * tools in this app do: public socket for market data, OTP-authenticated
 * socket for proposals and purchases.
 */

const PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const OPTIONS_API_URL = PUBLIC_WS_URL.replace(/ws\/public$/, '');

const MARKETS: { id: string; name: string; pip: number }[] = [
    { id: '1HZ10V', name: 'Volatility 10 (1s) Index', pip: 2 },
    { id: '1HZ25V', name: 'Volatility 25 (1s) Index', pip: 2 },
    { id: '1HZ50V', name: 'Volatility 50 (1s) Index', pip: 2 },
    { id: '1HZ75V', name: 'Volatility 75 (1s) Index', pip: 2 },
    { id: '1HZ100V', name: 'Volatility 100 (1s) Index', pip: 2 },
    { id: 'R_10', name: 'Volatility 10 Index', pip: 3 },
    { id: 'R_25', name: 'Volatility 25 Index', pip: 3 },
    { id: 'R_50', name: 'Volatility 50 Index', pip: 4 },
    { id: 'R_75', name: 'Volatility 75 Index', pip: 4 },
    { id: 'R_100', name: 'Volatility 100 Index', pip: 2 },
];

type TradeKind = 'over_under' | 'even_odd' | 'matches_differs' | 'rise_fall';

const TRADE_KINDS: Record<
    TradeKind,
    { label: string; a: { type: string; label: string }; b: { type: string; label: string }; needsDigit: boolean }
> = {
    over_under: {
        label: 'Over/Under',
        a: { type: 'DIGITOVER', label: 'Over' },
        b: { type: 'DIGITUNDER', label: 'Under' },
        needsDigit: true,
    },
    even_odd: {
        label: 'Even/Odd',
        a: { type: 'DIGITEVEN', label: 'Even' },
        b: { type: 'DIGITODD', label: 'Odd' },
        needsDigit: false,
    },
    matches_differs: {
        label: 'Matches/Differs',
        a: { type: 'DIGITMATCH', label: 'Matches' },
        b: { type: 'DIGITDIFF', label: 'Differs' },
        needsDigit: true,
    },
    rise_fall: {
        label: 'Rise/Fall',
        a: { type: 'CALL', label: 'Rise' },
        b: { type: 'PUT', label: 'Fall' },
        needsDigit: false,
    },
};

const HISTORY_COUNT = 1000;
const CHART_POINTS = 100;
const MAX_TRADES = 15;

type Quote = { quote: number; epoch: number };
type ProposalInfo = { id: string; ask_price: number; payout: number; message?: string };
type TradeRow = {
    contract_id: number;
    label: string;
    symbol: string;
    buy_price: number;
    profit?: number;
    status: 'open' | 'won' | 'lost';
};

const lastDigitOf = (quote: number, pip: number) => {
    const text = quote.toFixed(pip);
    return Number(text[text.length - 1]);
};

const fmt = (n: number | undefined, digits = 2) => (n === undefined || Number.isNaN(n) ? '-' : n.toFixed(digits));

export const DTraderTab = observer(() => {
    const { client } = useStore();

    const [symbol, setSymbol] = React.useState('1HZ100V');
    const [kind, setKind] = React.useState<TradeKind>('over_under');
    const [ticks, setTicks] = React.useState(5);
    const [digit, setDigit] = React.useState(5);
    const [basis, setBasis] = React.useState<'stake' | 'payout'>('stake');
    const [amount, setAmount] = React.useState(10);
    const [prices, setPrices] = React.useState<Quote[]>([]);
    const [pip, setPip] = React.useState(2);
    const [status, setStatus] = React.useState('Connecting...');
    const [isAuthed, setIsAuthed] = React.useState(false);
    const [proposals, setProposals] = React.useState<Record<string, ProposalInfo | undefined>>({});
    const [trades, setTrades] = React.useState<TradeRow[]>([]);
    const [message, setMessage] = React.useState('');
    const [buying, setBuying] = React.useState(false);

    const wsRef = React.useRef<WebSocket | null>(null);
    const symbolRef = React.useRef(symbol);
    const pipRef = React.useRef(pip);
    const reconnectRef = React.useRef<number | undefined>(undefined);
    const aliveRef = React.useRef(true);
    const reqIdRef = React.useRef(1);

    symbolRef.current = symbol;
    const market = MARKETS.find(m => m.id === symbol) || MARKETS[0];
    const cfg = TRADE_KINDS[kind];

    const send = React.useCallback((payload: Record<string, unknown>) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ ...payload, req_id: reqIdRef.current++ }));
            return true;
        }
        return false;
    }, []);

    const subscribeMarket = React.useCallback(
        (sym: string) => {
            send({ forget_all: 'ticks' });
            setPrices([]);
            send({
                ticks_history: sym,
                adjust_start_time: 1,
                count: HISTORY_COUNT,
                end: 'latest',
                style: 'ticks',
                subscribe: 1,
            });
        },
        [send]
    );

    // ---- socket lifecycle -------------------------------------------------
    const connect = React.useCallback(async () => {
        window.clearTimeout(reconnectRef.current);
        if (wsRef.current) {
            const old = wsRef.current;
            wsRef.current = null;
            old.onclose = null;
            try {
                old.close();
            } catch {
                /* ignore */
            }
        }

        let url = PUBLIC_WS_URL;
        let authed = false;
        const auth = getDerivAuthContext();
        if (auth) {
            try {
                const res = await fetch(`${OPTIONS_API_URL}accounts/${auth.activeAccount.account_id}/otp`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${auth.accessToken}` },
                });
                const json = await res.json();
                if (res.ok && json?.data?.url) {
                    url = json.data.url;
                    authed = true;
                } else {
                    setMessage('Could not open your trading session. Showing market data only.');
                }
            } catch {
                setMessage('Could not reach Deriv to open your trading session. Showing market data only.');
            }
        }
        if (!aliveRef.current) return;

        setIsAuthed(authed);
        setStatus('Connecting...');
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            setStatus(authed ? 'Live' : 'Live (log in to trade)');
            subscribeMarket(symbolRef.current);
            if (authed) send({ transaction: 1, subscribe: 1 });
        };

        ws.onmessage = event => {
            let data: any;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }

            if (data.error) {
                // proposals for an invalid combination are reported here
                if (data.msg_type === 'proposal') {
                    const t = data.echo_req?.passthrough?.side as string | undefined;
                    if (t) setProposals(p => ({ ...p, [t]: { id: '', ask_price: 0, payout: 0, message: data.error.message } }));
                } else if (data.msg_type === 'buy') {
                    setBuying(false);
                    setMessage(data.error.message);
                } else if (data.msg_type !== 'forget_all' && data.msg_type !== 'transaction') {
                    setMessage(data.error.message);
                }
                return;
            }

            switch (data.msg_type) {
                case 'history': {
                    const times: number[] = data.history?.times || [];
                    const list: number[] = data.history?.prices || [];
                    const resolvedPip = Number(data.pip_size ?? data.history?.pip_size);
                    if (resolvedPip) {
                        setPip(resolvedPip);
                        pipRef.current = resolvedPip;
                    } else {
                        const fallback = MARKETS.find(m => m.id === symbolRef.current)?.pip ?? 2;
                        setPip(fallback);
                        pipRef.current = fallback;
                    }
                    setPrices(list.map((q, i) => ({ quote: Number(q), epoch: times[i] })));
                    break;
                }
                case 'tick': {
                    if (data.tick?.symbol !== symbolRef.current) break;
                    if (data.tick.pip_size) {
                        setPip(Number(data.tick.pip_size));
                        pipRef.current = Number(data.tick.pip_size);
                    }
                    setPrices(prev => {
                        const next = prev.concat({ quote: Number(data.tick.quote), epoch: data.tick.epoch });
                        return next.length > HISTORY_COUNT ? next.slice(next.length - HISTORY_COUNT) : next;
                    });
                    break;
                }
                case 'proposal': {
                    const side = data.echo_req?.passthrough?.side as string | undefined;
                    if (!side || !data.proposal) break;
                    setProposals(p => ({
                        ...p,
                        [side]: {
                            id: data.proposal.id,
                            ask_price: Number(data.proposal.ask_price),
                            payout: Number(data.proposal.payout),
                        },
                    }));
                    break;
                }
                case 'buy': {
                    setBuying(false);
                    const info = data.buy;
                    if (!info) break;
                    const label = data.echo_req?.passthrough?.label || 'Contract';
                    setMessage('');
                    setTrades(prev =>
                        [
                            {
                                contract_id: info.contract_id,
                                label,
                                symbol: data.echo_req?.passthrough?.symbol || '',
                                buy_price: Number(info.buy_price),
                                status: 'open' as const,
                            },
                            ...prev,
                        ].slice(0, MAX_TRADES)
                    );
                    send({ proposal_open_contract: 1, contract_id: info.contract_id, subscribe: 1 });
                    break;
                }
                case 'proposal_open_contract': {
                    const c = data.proposal_open_contract;
                    if (!c) break;
                    if (c.is_sold || c.status === 'won' || c.status === 'lost') {
                        const profit = Number(c.profit);
                        setTrades(prev =>
                            prev.map(t =>
                                t.contract_id === c.contract_id
                                    ? { ...t, profit, status: profit >= 0 ? 'won' : 'lost' }
                                    : t
                            )
                        );
                        if (data.subscription?.id) send({ forget: data.subscription.id });
                    }
                    break;
                }
                default:
                    break;
            }
        };

        ws.onerror = () => setStatus('Connection problem');
        ws.onclose = () => {
            if (!aliveRef.current || wsRef.current !== ws) return;
            setStatus('Reconnecting...');
            reconnectRef.current = window.setTimeout(() => connect(), 2000);
        };
    }, [send, subscribeMarket]);

    // connect on mount and whenever the active account changes
    React.useEffect(() => {
        aliveRef.current = true;
        connect();
        return () => {
            aliveRef.current = false;
            window.clearTimeout(reconnectRef.current);
            const ws = wsRef.current;
            wsRef.current = null;
            if (ws) {
                ws.onclose = null;
                ws.close();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client.loginid, client.is_logged_in]);

    // change market
    const firstRun = React.useRef(true);
    React.useEffect(() => {
        if (firstRun.current) {
            firstRun.current = false;
            return;
        }
        subscribeMarket(symbol);
    }, [symbol, subscribeMarket]);

    // ---- live proposals ----------------------------------------------------
    React.useEffect(() => {
        if (!isAuthed || !(amount > 0)) {
            setProposals({});
            return;
        }
        const timer = window.setTimeout(() => {
            send({ forget_all: 'proposal' });
            setProposals({});
            (['a', 'b'] as const).forEach(side => {
                const spec = cfg[side];
                const payload: Record<string, unknown> = {
                    proposal: 1,
                    subscribe: 1,
                    amount,
                    basis,
                    contract_type: spec.type,
                    currency: client.currency || 'USD',
                    underlying_symbol: symbol,
                    duration: ticks,
                    duration_unit: 't',
                    passthrough: { side, label: spec.label, symbol },
                };
                if (cfg.needsDigit) payload.barrier = String(digit);
                send(payload);
            });
        }, 350);
        return () => window.clearTimeout(timer);
    }, [isAuthed, amount, basis, kind, ticks, digit, symbol, client.currency, cfg, send]);

    const buy = (side: 'a' | 'b') => {
        const p = proposals[side];
        if (!p?.id || buying) return;
        setBuying(true);
        setMessage('');
        const ok = send({
            buy: p.id,
            price: p.ask_price,
            passthrough: { label: cfg[side].label, symbol },
        });
        if (!ok) {
            setBuying(false);
            setMessage('Connection lost. Please try again in a moment.');
        }
    };

    // ---- derived chart/digit data -------------------------------------------
    const visible = prices.slice(-CHART_POINTS);
    const last = prices[prices.length - 1];
    const prev = prices[prices.length - 2];
    const change = last && prev ? last.quote - prev.quote : 0;

    const digitCounts = React.useMemo(() => {
        const counts = new Array(10).fill(0);
        prices.forEach(p => {
            counts[lastDigitOf(p.quote, pip)] += 1;
        });
        return counts;
    }, [prices, pip]);
    const totalDigits = digitCounts.reduce((a, b) => a + b, 0) || 1;
    const maxCount = Math.max(...digitCounts);
    const minCount = Math.min(...digitCounts);
    const lastDigit = last ? lastDigitOf(last.quote, pip) : -1;

    const chart = React.useMemo(() => {
        if (visible.length < 2) return null;
        const qs = visible.map(v => v.quote);
        let lo = Math.min(...qs);
        let hi = Math.max(...qs);
        if (hi - lo < 1e-9) {
            hi += 0.5;
            lo -= 0.5;
        }
        const pad = (hi - lo) * 0.12;
        lo -= pad;
        hi += pad;
        const W = 1000;
        const H = 400;
        const pts = visible.map((v, i) => {
            const x = (i / (visible.length - 1)) * W;
            const y = H - ((v.quote - lo) / (hi - lo)) * H;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        const lastY = H - ((qs[qs.length - 1] - lo) / (hi - lo)) * H;
        return { line: pts.join(' '), area: `0,${H} ${pts.join(' ')} ${W},${H}`, lastY, lo, hi };
    }, [visible]);

    const canBuy = isAuthed && !buying;
    const pa = proposals.a;
    const pb = proposals.b;

    return (
        <div className='nd'>
            <div className='nd__main'>
                <div className='nd__chart-card'>
                    <div className='nd__chart-head'>
                        <select
                            className='nd__select'
                            value={symbol}
                            onChange={e => setSymbol(e.target.value)}
                            aria-label='Market'
                        >
                            {MARKETS.map(m => (
                                <option key={m.id} value={m.id}>
                                    {m.name}
                                </option>
                            ))}
                        </select>
                        <div className='nd__price'>
                            <strong>{last ? last.quote.toFixed(pip) : '-'}</strong>
                            <span className={change >= 0 ? 'nd__up' : 'nd__down'}>
                                {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(pip)}
                            </span>
                        </div>
                        <span className='nd__status'>{status}</span>
                    </div>

                    <div className='nd__chart'>
                        {chart ? (
                            <svg viewBox='0 0 1000 400' preserveAspectRatio='none' className='nd__svg'>
                                <polygon points={chart.area} className='nd__area' />
                                <polyline points={chart.line} className='nd__line' fill='none' />
                                <line x1='0' x2='1000' y1={chart.lastY} y2={chart.lastY} className='nd__spot-line' />
                            </svg>
                        ) : (
                            <div className='nd__loading'>Loading market data...</div>
                        )}
                        {chart && last && (
                            <div
                                className='nd__spot'
                                style={{ top: `${Math.min(92, Math.max(2, (chart.lastY / 400) * 100))}%` }}
                            >
                                {last.quote.toFixed(pip)}
                            </div>
                        )}
                        {chart && (
                            <>
                                <span className='nd__axis nd__axis--hi'>{chart.hi.toFixed(pip)}</span>
                                <span className='nd__axis nd__axis--lo'>{chart.lo.toFixed(pip)}</span>
                            </>
                        )}
                    </div>

                    <div className='nd__digits' aria-label='Last digit statistics'>
                        {digitCounts.map((c, d) => {
                            const pct = (c / totalDigits) * 100;
                            const cls = [
                                'nd__digit',
                                c === maxCount ? 'nd__digit--max' : '',
                                c === minCount ? 'nd__digit--min' : '',
                                d === lastDigit ? 'nd__digit--last' : '',
                            ].join(' ');
                            return (
                                <div key={d} className={cls}>
                                    <b>{d}</b>
                                    <small>{pct.toFixed(1)}%</small>
                                </div>
                            );
                        })}
                    </div>
                </div>

                <div className='nd__trades'>
                    <h4>Recent trades</h4>
                    {trades.length === 0 ? (
                        <p className='nd__muted'>Your trades will appear here.</p>
                    ) : (
                        <table>
                            <thead>
                                <tr>
                                    <th>Contract</th>
                                    <th>Market</th>
                                    <th>Stake</th>
                                    <th>Result</th>
                                </tr>
                            </thead>
                            <tbody>
                                {trades.map(t => (
                                    <tr key={t.contract_id}>
                                        <td>{t.label}</td>
                                        <td>{t.symbol}</td>
                                        <td>{fmt(t.buy_price)}</td>
                                        <td className={t.status === 'won' ? 'nd__up' : t.status === 'lost' ? 'nd__down' : ''}>
                                            {t.status === 'open'
                                                ? 'Running...'
                                                : `${(t.profit ?? 0) >= 0 ? '+' : ''}${fmt(t.profit)}`}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            <aside className='nd__panel'>
                <div className='nd__card'>
                    <div className='nd__kinds' role='tablist'>
                        {(Object.keys(TRADE_KINDS) as TradeKind[]).map(k => (
                            <button
                                key={k}
                                role='tab'
                                aria-selected={k === kind}
                                className={k === kind ? 'is-active' : ''}
                                onClick={() => setKind(k)}
                            >
                                {TRADE_KINDS[k].label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className='nd__card'>
                    <label className='nd__label'>Duration: {ticks} {ticks === 1 ? 'tick' : 'ticks'}</label>
                    <input
                        type='range'
                        min={1}
                        max={10}
                        step={1}
                        value={ticks}
                        onChange={e => setTicks(Number(e.target.value))}
                        className='nd__range'
                    />
                </div>

                {cfg.needsDigit && (
                    <div className='nd__card'>
                        <label className='nd__label'>Last digit prediction</label>
                        <div className='nd__grid'>
                            {Array.from({ length: 10 }, (_, d) => (
                                <button
                                    key={d}
                                    className={d === digit ? 'is-active' : ''}
                                    onClick={() => setDigit(d)}
                                >
                                    {d}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className='nd__card'>
                    <div className='nd__basis'>
                        <button className={basis === 'stake' ? 'is-active' : ''} onClick={() => setBasis('stake')}>
                            Stake
                        </button>
                        <button className={basis === 'payout' ? 'is-active' : ''} onClick={() => setBasis('payout')}>
                            Payout
                        </button>
                    </div>
                    <div className='nd__amount'>
                        <button onClick={() => setAmount(a => Math.max(1, Number((a - 1).toFixed(2))))} aria-label='Decrease'>
                            −
                        </button>
                        <input
                            type='number'
                            min={0.35}
                            step={0.5}
                            value={amount}
                            onChange={e => setAmount(Number(e.target.value))}
                        />
                        <span>{client.currency || 'USD'}</span>
                        <button onClick={() => setAmount(a => Number((a + 1).toFixed(2)))} aria-label='Increase'>
                            +
                        </button>
                    </div>
                </div>

                {(['a', 'b'] as const).map(side => {
                    const p = side === 'a' ? pa : pb;
                    const spec = cfg[side];
                    return (
                        <div key={side} className='nd__card'>
                            <div className='nd__payout'>
                                Payout <b>{p && !p.message ? fmt(p.payout) : '-'}</b>{' '}
                                {p && !p.message && p.ask_price > 0 ? (
                                    <small>Stake {fmt(p.ask_price)}</small>
                                ) : null}
                            </div>
                            <button
                                className={`nd__buy nd__buy--${side}`}
                                disabled={!canBuy || !p?.id}
                                onClick={() => buy(side)}
                            >
                                {spec.label}
                                {p && !p.message && p.ask_price > 0
                                    ? ` · ${(((p.payout - p.ask_price) / p.ask_price) * 100).toFixed(2)}%`
                                    : ''}
                            </button>
                            {p?.message && <p className='nd__error'>{p.message}</p>}
                        </div>
                    );
                })}

                {!isAuthed && <p className='nd__notice'>Log in to your Deriv account to place trades.</p>}
                {message && <p className='nd__error'>{message}</p>}
            </aside>
        </div>
    );
});

export default DTraderTab;
