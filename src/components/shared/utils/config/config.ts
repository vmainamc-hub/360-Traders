import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';
import brandConfig from '../../../../../brand.config.json';

// =============================================================================
// Constants - Derived from brand.config.json
// =============================================================================

export const CLIENT_ID = '34xXPt5IBhYDWeznie5sH';

// Dynamic redirect URI — always points to the current origin's /callback route.
// This works on any domain (Replit dev, deployed, custom) without hardcoding.
export const REDIRECT_URI = `${window.location.origin}/callback`;

// Construct WebSocket URLs from platform.derivws config
export const WS_SERVERS = {
    STAGING: `${brandConfig.platform.derivws.url.staging}${brandConfig.platform.derivws.directories.options}ws/public`,
    PRODUCTION: `${brandConfig.platform.derivws.url.production}${brandConfig.platform.derivws.directories.options}ws/public`,
} as const;

// =============================================================================
// Environment Helpers (Hardcoded to Production for Auth)
// =============================================================================

export const isLocal = () => /localhost(:\d+)?$/i.test(window.location.hostname);

// Force production logic to ensure we always use bmtraders.site for OAuth
export const isProduction = () => true;

const getDefaultServerURL = () => {
    return WS_SERVERS.PRODUCTION;
};

export const getSocketURL = async (): Promise<string> => {
    try {
        // Prefer the old OAuth flow token (auth_info in sessionStorage)
        const authInfo = OAuthTokenExchangeService.getAuthInfo();
        const activeLoginId = localStorage.getItem('active_loginid') ?? undefined;

        if (authInfo?.access_token) {
            return await DerivWSAccountsService.getAuthenticatedWebSocketURL(
                authInfo.access_token,
                activeLoginId
            );
        }

        // Fall back to the new auth flow token (NEW_AUTH_token in localStorage).
        // This is the token stored by NewDerivAuth.js after PKCE OAuth login.
        // Using it here ensures api_base.api gets an OTP-authenticated WS URL
        // instead of the unauthenticated public URL.
        const { getNewToken } = await import('@/auth/NewDerivAuth');
        const newToken = getNewToken();
        if (newToken) {
            return await DerivWSAccountsService.getAuthenticatedWebSocketURL(
                newToken,
                activeLoginId
            );
        }

        return getDefaultServerURL();
    } catch (error) {
        console.error('[DerivWS] Socket URL Error:', error);
        return getDefaultServerURL();
    }
};

// =============================================================================
// Security Helpers (PKCE & CSRF)
// =============================================================================

const generateSecureString = (length = 32): string => {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
};

const generateCodeChallenge = async (verifier: string): Promise<string> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return btoa(String.fromCharCode(...hashArray))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
};

export const storeCSRFToken = (token: string) => {
    sessionStorage.setItem('oauth_csrf_token', token);
    sessionStorage.setItem('oauth_csrf_token_timestamp', Date.now().toString());
};

export const validateCSRFToken = (token: string): boolean => {
    const storedToken = sessionStorage.getItem('oauth_csrf_token');
    if (!storedToken) return false;
    // Direct comparison for callback validation
    return storedToken === token;
};

export const clearCSRFToken = () => {
    sessionStorage.removeItem('oauth_csrf_token');
    sessionStorage.removeItem('oauth_csrf_token_timestamp');
};

export const getCodeVerifier = () => sessionStorage.getItem('oauth_code_verifier');

export const clearCodeVerifier = () => {
    sessionStorage.removeItem('oauth_code_verifier');
    sessionStorage.removeItem('oauth_code_verifier_timestamp');
};

// =============================================================================
// OAuth URL Generator
// =============================================================================

export const generateOAuthURL = async (prompt?: string) => {
    try {
        // Pulls https://auth.deriv.com/oauth2/ from brand.config.json
        const authBase = brandConfig.platform.auth2_url.production;
        const authHost = authBase.endsWith('/') ? `${authBase}auth` : `${authBase}/auth`;

        const csrfToken = generateSecureString();
        storeCSRFToken(csrfToken);

        const codeVerifier = generateSecureString();
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        // Store PKCE verifier
        sessionStorage.setItem('oauth_code_verifier', codeVerifier);
        sessionStorage.setItem('oauth_code_verifier_timestamp', Date.now().toString());

        const params = new URLSearchParams({
            scope: brandConfig.platform.oauth_scopes,
            response_type: 'code',
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            state: csrfToken,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        });

        if (prompt) params.append('prompt', prompt);

        const finalUrl = `${authHost}?${params.toString()}`;

        console.log('[OAuth] Production URL:', finalUrl);
        return finalUrl;
    } catch (error) {
        console.error('Error generating OAuth URL:', error);
        return '';
    }
};
