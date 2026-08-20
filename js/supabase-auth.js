/**
 * ============================================================================
 * AKRA ECOSYSTEM SUPABASE AUTH & API CLIENT (MAIN PORTAL)
 * Status: DEACTIVATED / CONTAINED for Security Hardening (Plan 20260820-004)
 * Authentication and Token Signing must execute on trusted backend (GAS/Server).
 * ============================================================================
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AkraSupabaseAuth = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    const SUPABASE_CONFIG = {
        URL: 'https://hgxrrskztbpejirrdpbq.supabase.co',
        KEY: ''
    };

    return {
        login: async () => {
            console.warn('[Security Containment] Direct client-side authentication is disabled. Falling back to secure server/GAS boundary.');
            return { status: 'fallback_to_gas' };
        },
        verifyToken: async () => {
            return { status: 'fallback_to_gas' };
        },
        getAdminData: async () => {
            return { status: 'fallback_to_gas' };
        },
        changePassword: async () => {
            return { status: 'fallback_to_gas' };
        },
        saveUser: async () => {
            return { status: 'fallback_to_gas' };
        },
        saveAppConfig: async () => {
            return { status: 'fallback_to_gas' };
        }
    };
}));
