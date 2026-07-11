import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.vacapay.muzzlefield',
  appName: 'Vacapay Field',
  webDir: 'dist/vacapay/browser',
  backgroundColor: '#eef3f6',
  android: {
    backgroundColor: '#eef3f6',
    buildOptions: {
      releaseType: 'APK'
    }
  },
  server: {
    androidScheme: 'https'
  }
};

export default config;
