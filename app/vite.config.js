import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    minify: 'esbuild',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-leaflet': ['leaflet'],
          'vendor-exceljs': ['exceljs'],
        },
      },
    },
  },
  esbuild: {
    drop: ['console', 'debugger'],
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'robots.txt'],
      manifest: {
        name: 'Transportes Díaz SpA — Sistema de Registro de Viajes',
        short_name: 'Transportes Díaz',
        description: 'App de gestión de viajes para conductores y backoffice',
        theme_color: '#1a237e',
        background_color: '#f9f9f9',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        lang: 'es-CL',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'osm-tiles', expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }, cacheableResponse: { statuses: [0, 200] } },
          },
          {
            urlPattern: /^https:\/\/router\.project-osrm\.org\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'osrm-routes', expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 }, networkTimeoutSeconds: 5 },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts-webfonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/trip_positions.*/i,
            handler: 'NetworkOnly',
            options: { backgroundSync: { name: 'trip-positions-queue', options: { maxRetentionTime: 24 * 60 } } },
          },
        ],
      },
    }),
  ],
});
