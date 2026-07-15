import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [provideHttpClient(), provideAnimations()]
}).then(() => {
  const isNativeApp = Boolean((window as any).Capacitor?.isNativePlatform?.());
  if (!isNativeApp && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Admin and browser testing must always use the current deployment. The
      // field APK owns offline capture, so stale web app shells add risk without
      // providing a required production capability.
      void navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => {});

      if ('caches' in window) {
        void caches.keys()
          .then((keys) => Promise.all(keys.filter((key) => key.startsWith('vacapay-')).map((key) => caches.delete(key))))
          .catch(() => {});
      }
    });
  }
}).catch((error) => console.error(error));
