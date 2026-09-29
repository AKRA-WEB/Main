(function () {
    'use strict';

    const button = document.getElementById('main-pwa-install');
    const installHelp = document.getElementById('main-pwa-install-help');
    if (!button) return;

    let installPrompt = null;
    let installed = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;

    function sync() {
        button.hidden = installed || !installPrompt;
        if (installHelp) installHelp.hidden = installed || !!installPrompt;
    }

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        if (installed) return;
        installPrompt = event;
        sync();
    });

    window.addEventListener('appinstalled', () => {
        installed = true;
        installPrompt = null;
        sync();
    });

    button.addEventListener('click', async () => {
        const prompt = installPrompt;
        if (!prompt || installed) return;
        installPrompt = null;
        sync();
        try {
            await prompt.prompt();
            const choice = await prompt.userChoice;
            if (choice?.outcome === 'accepted') installed = true;
        } catch (error) {
            console.warn('AKRA app installation prompt was unavailable:', error);
        } finally {
            sync();
        }
    });

    sync();
}());
