import Cookies from 'js-cookie';

const _newSystemHandlers = new Set();
const _pendingRequests = new Map();
let _reqIdCounter = 1;

_newSystemHandlers.add((event) => {
    try {
        const data = JSON.parse(event.data);
        if (data.req_id != null && _pendingRequests.has(data.req_id)) {
            const entry = _pendingRequests.get(data.req_id);
            if (data.error) {
                entry.reject({ error: data.error, echo_req: data.echo_req || data });
            } else {
                entry.resolve(data);
            }
            _pendingRequests.delete(data.req_id);
        }
    } catch (_) {}
});

export function onNewSystemMessage(handler) {
    _newSystemHandlers.add(handler);
    return () => _newSystemHandlers.delete(handler);
}

export function sendViaNewSystem(data) {
    if (window._newSystemWS?.readyState === WebSocket.OPEN) {
        window._newSystemWS.send(JSON.stringify(convertToNewFormat(data)));
        return true;
    }
    return false;
}

function convertToNewFormat(data) {
    if (!data || typeof data !== 'object') return data;
    const out = Array.isArray(data) ? data.map(convertToNewFormat) : { ...data };
    if (out.proposal === 1 && out.symbol) {
        out.underlying_symbol = out.symbol;
        delete out.symbol;
    }
    if ('buy' in out) {
        out.buy = String(out.buy);
    }
    if (out.parameters && typeof out.parameters === 'object') {
        out.parameters = { ...out.parameters };
        if ('symbol' in out.parameters) {
            out.parameters.underlying_symbol = out.parameters.symbol;
            delete out.parameters.symbol;
        }
    }
    return out;
}

export function sendViaNewSystemWithPromise(data) {
    return new Promise((resolve, reject) => {
        const reqId = data.req_id || ++_reqIdCounter;
        data = { ...data, req_id: reqId };
        const converted = convertToNewFormat(data);
        _pendingRequests.set(reqId, { resolve, reject });
        if (!sendViaNewSystem(converted)) {
            _pendingRequests.delete(reqId);
            reject({
                error: {
                    code: 'DisconnectError',
                    message: 'New system WebSocket is not connected.',
                },
            });
        }
    });
}

export function subscribeNewSystemTopics() {
    if (window._newSystemTopicsSubscribed) return true;
    const ws = window._newSystemWS;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        ws.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
        window._newSystemTopicsSubscribed = true;
        console.log('[NEW WS] Subscribed to balance & POC updates');
    } catch (e) {
        console.warn('[NEW WS] Could not subscribe:', e);
        return false;
    }
    return true;
}

const getRedirectUri = () => `${window.location.origin}/callback`;

const CONFIG = {
    clientId:  '34xXPt5IBhYDWeznie5sH',
    authUrl:   'https://auth.deriv.com/oauth2/auth',
    tokenUrl:  'https://auth.deriv.com/oauth2/token',
    restBase:  'https://api.derivws.com/trading/v1',
    scope:     'trade',
};

const K = {
    token:    'NEW_AUTH_token',
    expiry:   'NEW_AUTH_expiry',
    verifier: 'NEW_AUTH_verifier',
    state:    'NEW_AUTH_state',
    active:   'NEW_AUTH_active',
};

export function clearNewAuthStorage() {
    localStorage.removeItem(K.token);
    localStorage.removeItem(K.expiry);
    localStorage.removeItem(K.verifier);
    localStorage.removeItem(K.state);
    localStorage.removeItem(K.active);
    sessionStorage.removeItem(K.token);
    sessionStorage.removeItem(K.expiry);
    sessionStorage.removeItem(K.verifier);
    sessionStorage.removeItem(K.state);
    sessionStorage.removeItem(K.active);
    localStorage.removeItem('accountsList');
    localStorage.removeItem('clientAccounts');
    localStorage.removeItem('active_loginid');
    localStorage.removeItem('authToken');
    localStorage.removeItem('client_account_details');
    localStorage.removeItem('show_as_cr');
    localStorage.removeItem('callback_token');
    localStorage.removeItem('client.accounts');
    localStorage.removeItem('client.country');
    sessionStorage.removeItem('cached_balances');
    try { Cookies.remove('logged_state', { path: '/', domain: window.location.hostname }); } catch {}
}

async function buildCodeChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function generateVerifier() {
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' +
        '0123456789-._~';
    const array = new Uint8Array(64);
    crypto.getRandomValues(array);
    return Array.from(array)
        .map(x => chars[x % chars.length])
        .join('');
}

export async function startNewLogin() {
    console.log('[NEW AUTH] Login started...');
    clearNewAuthStorage();

    const verifier = generateVerifier();
    const challenge = await buildCodeChallenge(verifier);
    const state = crypto.randomUUID();

    localStorage.setItem(K.verifier, verifier);
    localStorage.setItem(K.state, state);
    localStorage.setItem(K.active, 'true');

    const savedVerifier = localStorage.getItem(K.verifier);
    if (!savedVerifier) {
        throw new Error(
            'Failed to save login data to localStorage. ' +
            'Your browser may be blocking storage. Try disabling ' +
            'private browsing or browser extensions.'
        );
    }

    const redirectUri = getRedirectUri();
    const params = new URLSearchParams({
        response_type:         'code',
        client_id:             CONFIG.clientId,
        redirect_uri:          redirectUri,
        scope:                 CONFIG.scope,
        state:                 state,
        code_challenge:        challenge,
        code_challenge_method: 'S256',
    });

    // Append prompt manually so the space is encoded as %20, not +
    const loginUrl = CONFIG.authUrl + '?' + params.toString() + '&prompt=login%20consent';
    console.log('[NEW AUTH] Redirecting to:', loginUrl);
    window.location.href = loginUrl;
}

export async function startNewSignup() {
    console.log('[NEW AUTH] Signup started...');
    clearNewAuthStorage();

    const verifier = generateVerifier();
    const challenge = await buildCodeChallenge(verifier);
    const state = crypto.randomUUID();

    localStorage.setItem(K.verifier, verifier);
    localStorage.setItem(K.state, state);
    localStorage.setItem(K.active, 'true');

    const redirectUri = getRedirectUri();
    const params = new URLSearchParams({
        response_type:         'code',
        client_id:             CONFIG.clientId,
        redirect_uri:          redirectUri,
        scope:                 CONFIG.scope,
        state:                 state,
        code_challenge:        challenge,
        code_challenge_method: 'S256',
        prompt:                'registration',
    });

    window.location.href = CONFIG.authUrl + '?' + params.toString();
}

let _callbackHandled = false;

export async function handleNewCallback() {
    if (_callbackHandled) {
        console.log('[NEW AUTH] Callback already handled, skipping');
        return null;
    }
    _callbackHandled = true;

    console.log('[NEW AUTH] Starting callback handler');
    console.log('[NEW AUTH] URL:', window.location.search);

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const returnedState = urlParams.get('state');

    window.history.replaceState({}, '', '/callback');

    if (!code) throw new Error('Missing authorization code from Deriv');
    if (!returnedState) throw new Error('Missing state parameter from Deriv');

    const savedState = localStorage.getItem(K.state);
    if (!savedState) {
        throw new Error(
            'Session expired during login. ' +
            'Please go back and try again. ' +
            'Do not refresh the page during login.'
        );
    }
    if (savedState !== returnedState) {
        throw new Error('Security check failed. State mismatch detected. Please go back and try again.');
    }

    const verifier = localStorage.getItem(K.verifier);
    if (!verifier) {
        throw new Error(
            'Login data missing. ' +
            'This happens when login is opened in a new tab. ' +
            'Please go back and try again in the same tab.'
        );
    }

    console.log('[NEW AUTH] Exchanging code for token...');

    const redirectUri = getRedirectUri();
    let response;
    try {
        response = await fetch(CONFIG.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type:    'authorization_code',
                code:          code,
                redirect_uri:  redirectUri,
                client_id:     CONFIG.clientId,
                code_verifier: verifier,
            }).toString(),
        });
    } catch (networkErr) {
        throw new Error('Network error during login. Please check your internet connection and try again.');
    }

    const data = await response.json();
    console.log('[NEW AUTH] Token response status:', response.status);

    if (!response.ok) {
        const errMsg = data.error_description || data.error || 'Unknown error';
        console.error('[NEW AUTH] Token error:', errMsg);
        localStorage.removeItem(K.verifier);
        localStorage.removeItem(K.state);
        throw new Error('Login failed: ' + errMsg);
    }

    console.log('[NEW AUTH] Token received successfully');

    localStorage.setItem(K.token, data.access_token);
    localStorage.setItem(K.expiry, String(Date.now() + data.expires_in * 1000));
    localStorage.removeItem(K.verifier);
    localStorage.removeItem(K.state);

    const cookieDomain = window.location.hostname;
    document.cookie =
        'logged_state=true; path=/; domain=' + cookieDomain +
        '; max-age=' + 30 * 24 * 60 * 60 +
        '; secure=' + (window.location.protocol === 'https:');

    console.log('[NEW AUTH] Token saved. Login complete.');
    return data.access_token;
}

export function getNewToken() {
    let token = localStorage.getItem(K.token);
    let expiry = localStorage.getItem(K.expiry);
    if (!token || !expiry) {
        token = sessionStorage.getItem(K.token);
        expiry = sessionStorage.getItem(K.expiry);
    }
    if (!token || !expiry) return null;
    if (Date.now() > Number(expiry)) {
        localStorage.removeItem(K.token);
        localStorage.removeItem(K.expiry);
        sessionStorage.removeItem(K.token);
        sessionStorage.removeItem(K.expiry);
        return null;
    }
    return token;
}

export function isNewLoggedIn() {
    return getNewToken() !== null;
}

export function getNewAuthHeaders() {
    return {
        Authorization:  'Bearer ' + getNewToken(),
        'Content-Type': 'application/json',
    };
}

export function logoutNewSystem() {
    clearNewAuthStorage();
    window.location.href =
        'https://auth.deriv.com/oauth2/sessions/logout' +
        '?redirect_uri=' + encodeURIComponent(window.location.origin);
}

export async function createNewWebSocket() {
    const token = getNewToken();
    if (!token) {
        console.error('[NEW WS] No token available');
        return null;
    }

    console.log('[NEW WS] Getting accounts...');

    let accountsRes;
    try {
        accountsRes = await fetch(CONFIG.restBase + '/options/accounts', {
            headers: getNewAuthHeaders(),
        });
    } catch (e) {
        console.error('[NEW WS] Network error getting accounts:', e);
        return null;
    }

    const accountsText = await accountsRes.text();
    console.log('[NEW WS] Accounts response:', accountsText);

    if (!accountsRes.ok) {
        console.error('[NEW WS] Accounts error:', accountsText);
        return null;
    }

    let accountsData;
    try {
        accountsData = JSON.parse(accountsText);
    } catch (e) {
        console.error('[NEW WS] Could not parse accounts response');
        return null;
    }

    const accounts = accountsData.data || accountsData;
    const accountsArray = Array.isArray(accounts) ? accounts : accounts ? [accounts] : [];

    // Normalize: Deriv API may use account_id, id, or loginid depending on the endpoint
    const normalizeId = acc => acc.account_id ?? acc.id ?? acc.loginid ?? '';

    const savedLoginId = localStorage.getItem('active_loginid');
    let account = savedLoginId
        ? accountsArray.find(acc => normalizeId(acc) === savedLoginId)
        : null;

    if (!account) {
        if (savedLoginId) {
            console.warn(
                `[NEW WS] Saved loginid "${savedLoginId}" not found in accounts ` +
                `[${accountsArray.map(normalizeId).join(', ')}]. Falling back to first account.`
            );
        }
        account = accountsArray[0];
    }

    const accountId = normalizeId(account);

    const legacyAccountsList = {};
    const legacyClientAccounts = {};
    const legacyClientDetails = [];
    const realToken = getNewToken() || '';
    accountsArray.forEach(acc => {
        const lid = acc.account_id || acc.id;
        legacyAccountsList[lid] = realToken;
        legacyClientAccounts[lid] = { loginid: lid, token: realToken, currency: acc.currency || 'USD' };
        legacyClientDetails.push({
            loginid: lid,
            currency: acc.currency || 'USD',
            token: realToken,
            created_at: 0,
            is_virtual: acc.account_type === 'demo' ? 1 : 0,
            is_disabled: 0,
            landing_company_name: 'virtual',
            account_type: 'trading',
            account_category: 'trading',
            broker: '',
            currency_type: 'crypto',
            linked_to: [],
        });
    });
    localStorage.setItem('accountsList', JSON.stringify(legacyAccountsList));
    localStorage.setItem('clientAccounts', JSON.stringify(legacyClientAccounts));
    localStorage.setItem('client_account_details', JSON.stringify(legacyClientDetails));

    if (!accountId) {
        console.error('[NEW WS] No account ID found:', accountsData);
        return null;
    }

    console.log('[NEW WS] Using account:', accountId);
    console.log('[NEW WS] Getting OTP...');

    let otpRes;
    try {
        otpRes = await fetch(
            CONFIG.restBase + '/options/accounts/' + accountId + '/otp',
            { method: 'POST', headers: getNewAuthHeaders() }
        );
    } catch (e) {
        console.error('[NEW WS] Network error getting OTP:', e);
        return null;
    }

    const otpText = await otpRes.text();
    console.log('[NEW WS] OTP response:', otpText);

    if (!otpRes.ok) {
        console.error('[NEW WS] OTP error:', otpText);
        return null;
    }

    let otpData;
    try {
        otpData = JSON.parse(otpText);
    } catch (e) {
        console.error('[NEW WS] Could not parse OTP response');
        return null;
    }

    const wsUrl =
        otpData?.data?.url ||
        otpData?.data?.websocket_url ||
        otpData?.url ||
        otpData?.websocket_url;

    if (!wsUrl) {
        console.error('[NEW WS] No WebSocket URL in:', otpData);
        return null;
    }

    console.log('[NEW WS] Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
        console.log('[NEW WS] Connected and authenticated via OTP');
        window._newSystemWS = ws;
        window._newSystemWSReady = true;

        localStorage.setItem('active_loginid', accountId);
        localStorage.setItem('authToken', realToken);

        try {
            const cachedBalances = {};
            accountsArray.forEach(acc => {
                const lid = acc.account_id || acc.id;
                if (lid) {
                    const decimals = acc.currency === 'BTC' || acc.currency === 'ETH' ? 8 : 2;
                    cachedBalances[lid] = {
                        balance:   parseFloat(acc.balance || '0').toFixed(decimals),
                        currency:  acc.currency || 'USD',
                        timestamp: Date.now(),
                    };
                }
            });
            if (Object.keys(cachedBalances).length > 0) {
                sessionStorage.setItem('cached_balances', JSON.stringify(cachedBalances));
                console.log('[NEW WS] Cached balances saved:', cachedBalances);
            }
        } catch (e) {
            console.warn('[NEW WS] Could not cache balances:', e);
        }

        try {
            const {
                setAuthData,
                setAccountList,
                setConnectionStatus,
                CONNECTION_STATUS,
                setIsAuthorized,
                setIsAuthorizing,
            } = await import('@/external/bot-skeleton/services/api/observables/connection-status-stream');

            const accountList = accountsArray.map(acc => {
                const lid      = acc.account_id || acc.id;
                const decimals = acc.currency === 'BTC' || acc.currency === 'ETH' ? 8 : 2;
                return {
                    loginid:      lid,
                    currency:     acc.currency || 'USD',
                    balance:      parseFloat(parseFloat(acc.balance || '0').toFixed(decimals)),
                    is_virtual:   acc.account_type === 'demo' ? 1 : 0,
                    account_type: 'trading',
                    is_disabled:  0,
                    created_at:   0,
                    landing_company_name: 'virtual',
                    account_category:    'trading',
                    broker:        '',
                    currency_type: 'fiat',
                    linked_to:     [],
                };
            });

            setAccountList(accountList);
            setAuthData({
                loginid:    accountId,
                currency:   account.currency || 'USD',
                balance:    parseFloat(account.balance || '0'),
                email:      '',
                fullname:   '',
                is_virtual: account.account_type === 'demo' ? 1 : 0,
                landing_company_fullname: '',
                landing_company_name:     'virtual',
                linked_to:      [],
                local_currencies: {},
                preferred_language: 'EN',
                scopes:            ['read', 'trade', 'admin'],
                upgradeable_landing_companies: [],
                user_id:  0,
                token:    accountId,
                country:  '',
                account_list: accountList,
            });
            setConnectionStatus(CONNECTION_STATUS.OPENED);
            setIsAuthorized(true);
            setIsAuthorizing(false);
        } catch (e) {
            console.warn('[NEW WS] Could not wire legacy auth state:', e);
        }
    };

    ws.addEventListener('message', event => {
        _newSystemHandlers.forEach(handler => {
            try { handler(event); } catch (e) { console.warn('[NEW WS] Handler error:', e); }
        });
    });

    ws.addEventListener('message', event => {
        try {
            const data = JSON.parse(event.data);
            if (data.error) {
                console.warn(
                    '[NEW WS] Error for',
                    data.msg_type || JSON.stringify(data.echo_req).slice(0, 80),
                    ':',
                    data.error?.message || data.error?.code
                );
            } else if (data.msg_type) {
                console.log('[NEW WS] Message:', data.msg_type);
                if (data.msg_type === 'balance' && data.balance) {
                    let balanceData = data.balance;
                    if (!balanceData.accounts && typeof balanceData.balance === 'number') {
                        const lid =
                            balanceData.loginid ||
                            localStorage.getItem('active_loginid') ||
                            'unknown';
                        balanceData = {
                            accounts: {
                                [lid]: {
                                    balance: balanceData.balance,
                                    currency: balanceData.currency || 'USD',
                                    loginid: lid,
                                },
                            },
                        };
                    }
                    if (balanceData.accounts) {
                        // Update the account list observable so the header re-renders with fresh balances
                        import('@/external/bot-skeleton/services/api/observables/connection-status-stream')
                            .then(({ account_list$, setAccountList }) => {
                                const current = account_list$.getValue();
                                if (current && current.length > 0) {
                                    const updated = current.map(acc => {
                                        const fresh = balanceData.accounts[acc.loginid];
                                        return fresh
                                            ? { ...acc, balance: parseFloat(fresh.balance ?? fresh.balance) }
                                            : acc;
                                    });
                                    setAccountList(updated);
                                }
                            })
                            .catch(() => {});
                        window.dispatchEvent(
                            new CustomEvent('new-system-balance', { detail: balanceData })
                        );
                    }
                }
            }
        } catch (e) {
            console.warn('[NEW WS] Message parse error:', e);
        }
    });

    ws.onerror = e => {
        console.error('[NEW WS] Error:', e);
        window._newSystemWSReady = false;
    };

    ws.onclose = () => {
        console.log('[NEW WS] Closed. Reconnecting in 3s...');
        window._newSystemWSReady = false;
        window._newSystemTopicsSubscribed = false;
        setTimeout(() => {
            if (isNewLoggedIn()) {
                createNewWebSocket();
            }
        }, 3000);
    };

    return ws;
}

/**
 * Switch the active trading account without a full page reload.
 * Closes the current authenticated WS, updates active_loginid,
 * then re-runs createNewWebSocket() which picks up the new loginid.
 */
export async function switchNewAccount(loginid) {
    console.log('[NEW AUTH] Switching account to:', loginid);

    // Close existing authenticated WS so onclose auto-reconnect doesn't fire
    if (window._newSystemWS) {
        const old = window._newSystemWS;
        old.onclose = null; // suppress auto-reconnect
        old.close();
        window._newSystemWS = null;
        window._newSystemWSReady = false;
        window._newSystemTopicsSubscribed = false;
    }

    // Update the target account before reconnecting
    localStorage.setItem('active_loginid', loginid);

    // Signal UI that auth is in progress
    try {
        const { setIsAuthorized, setIsAuthorizing } =
            await import('@/external/bot-skeleton/services/api/observables/connection-status-stream');
        setIsAuthorized(false);
        setIsAuthorizing(true);
    } catch (e) {
        console.warn('[NEW AUTH] Could not set authorizing state:', e);
    }

    // Open new authenticated WS for the chosen account
    await createNewWebSocket();

    // Re-initialize the api_base WebSocket for the new account.
    // getSocketURL() will now fetch a fresh OTP for the new loginid,
    // ensuring api_base.api is connected to the correct account (not the public URL).
    try {
        const { api_base } = await import('@/external/bot-skeleton/services/api/api-base');
        // Clear the OTP cache so getSocketURL() fetches a fresh one for the new account
        const { DerivWSAccountsService } = await import('@/services/derivws-accounts.service');
        DerivWSAccountsService.clearCache();
        await api_base.init(true);
    } catch (e) {
        console.warn('[NEW AUTH] Could not reinitialize api_base for new account:', e);
    }
}
