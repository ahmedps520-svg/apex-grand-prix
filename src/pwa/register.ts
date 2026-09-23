/**
 * Registers the service worker in production builds and reports when a new version has been
 * downloaded and is waiting. The page only reloads when the user accepts the update.
 */
export function registerServiceWorker(onUpdateReady: (apply: () => void) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  let userAcceptedUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First installs also fire controllerchange (clients.claim), so only reload on request.
    if (userAcceptedUpdate) window.location.reload();
  });

  const offer = (worker: ServiceWorker) => {
    onUpdateReady(() => {
      userAcceptedUpdate = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((registration) => {
        if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              offer(installing);
            }
          });
        });
        // Long sessions (and the installed iPad app) should notice new versions too.
        const check = () => void registration.update().catch(() => undefined);
        setInterval(check, 30 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
      })
      .catch((error: unknown) => {
        console.warn('Service worker registration failed', error);
      });
  });
}
