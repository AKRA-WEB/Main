/**
 * ============================================================================
 * AKRA ECOSYSTEM SUPABASE AUTH & API CLIENT (MAIN PORTAL)
 * Status: DEACTIVATED / CONTAINED for Security Hardening (Plan 20260820-004)
 * Authentication and Token Signing must execute on the trusted Main backend.
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
            console.warn('[Security Containment] Direct client-side authentication is disabled; use the trusted Main boundary.');
            return { status: 'legacy_boundary_disabled' };
        },
        verifyToken: async () => {
            return { status: 'legacy_boundary_disabled' };
        },
        getAdminData: async () => {
            return { status: 'legacy_boundary_disabled' };
        },
        changePassword: async () => {
            return { status: 'legacy_boundary_disabled' };
        },
        saveUser: async () => {
            return { status: 'legacy_boundary_disabled' };
        },
        saveAppConfig: async () => {
            return { status: 'legacy_boundary_disabled' };
        }
    };
}));
