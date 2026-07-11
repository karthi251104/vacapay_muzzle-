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
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}).catch((error) => console.error(error));
