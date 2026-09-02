# Transportes Díaz SpA — Sistema de Registro de Viajes

Migración del prototipo de un solo archivo HTML (`prototype/transportes-diaz-app.html`)
a una aplicación real con backend **Supabase** (Postgres + Auth + Row Level Security
+ Storage privado + Edge Functions), manteniendo el diseño y el flujo de pantallas
originales.

## Stack

| Capa      | Tecnología |
|-----------|------------|
| Frontend  | Vite + JavaScript puro (`app/`), mismo diseño y pantallas del prototipo |
| Backend   | Supabase (Postgres, Auth email+contraseña, RLS, Storage, Edge Functions) |
| Cálculos  | Funciones Postgres `SECURITY DEFINER` (los montos nunca se calculan en el navegador) |
| Reportes  | Export a Excel vía ExcelJS (frontend) + impresión PDF |

## Estructura

```
transportes-diaz/
├── prototype/            # prototipo original (referencia, no se ejecuta)
├── app/                  # frontend Vite
│   ├── index.html
│   └── src/
│       ├── main.js       # init de Auth + enrutamiento por rol
│       ├── gate.js       # login con Supabase Auth (sin claves en JS)
│       ├── driver.js     # app de conductor (móvil)
│       ├── admin.js      # backoffice
│       ├── api.js        # capa de datos vía supabase-js (reemplaza localStorage)
│       └── lib.js        # utilidades + escape anti-XSS
├── supabase/
│   ├── migrations/       # 4 migraciones SQL en orden
│   └── functions/        # Edge Functions: create-user, delete-user
├── .env.example          # variables para la CLI / Edge Functions (solo admin)
└── app/.env.example      # variables VITE para el frontend
```

## Requisitos previos

- Node.js 18+ y npm
- Cuenta (gratuita o de pago) en [supabase.com](https://supabase.com)
- CLI de Supabase: `npm i -g supabase` (para Edge Functions; opcional si usas el dashboard)

## Puesta en marcha

### 1. Crear el proyecto en Supabase

1. Crea un proyecto y anota la **Project URL** y las claves (API section):
   - `supabaseUrl` (anon public)
   - `anon key`
   - `service_role key` (SOLO para la máquina del administrador; no debe nunca
     estar en la app ni en el repo).
2. En *Authentication → Providers → Email*, habilita email + contraseña.

### 2. Aplicar las migraciones

Las migraciones van en orden `0001` → `0005`:

```bash
supabase link --project-ref <REF>
supabase db push
```

O, si prefieres el editor SQL del dashboard, pégalo en este orden:
`0001_schema.sql`, `0002_rls.sql`, `0003_functions.sql`, `0004_storage.sql`, `0005_driver_trips.sql`.

> Importante: ejecutar en orden. `0002` habilita RLS; de nada sirve sin `0001`.

### 3. Crear el primer administrador

Como todavía no existe ningún admin que pueda usar la UI, crea el primero a mano:

1. En *Authentication → Users → Add user*: crea el correo corporativo con una
   contraseña temporal y, en **App metadata**, define:
   ```json
   { "role": "admin" }
   ```
2. En *SQL Editor*, inserta su registro de negocio:
   ```sql
   insert into public.admin_users (id, name, email, cargo, role, active)
   values (
     (select id from auth.users where email = 'tu.correo@transportesdiaz.cl'),
     'Nombre Apellido',
     'tu.correo@transportesdiaz.cl',
     'Gerencia de Operaciones',
     'admin',
     true
   );
   ```

A partir de ahí, el backoffice permite crear conductores (y otros admins) con
clave personal. **Nunca se usa una contraseña compartida ni escrita en el código.**

### 3b. Cargar datos de prueba (solo desarrollo)

`supabase/seed.sql` crea clientes, un contrato con dos CECOs y tarifas
**versionadas** (dos fechas de vigencia para probar el cálculo con tarifa correcta)
y vehículos. Solo contiene datos maestros: **no crea usuarios ni claves**.

```sql
-- En el SQL Editor del dashboard, luego de aplicar 0001 → 0005:
-- pega el contenido de supabase/seed.sql y ejecuta.
```

Es idempotente (puedes repetirlo sin duplicar). Los usuarios de prueba los creas
con el backoffice (paso 3) o en el dashboard; al elegir rol `conductor`/`admin`,
la app inserta automáticamente su fila en `drivers`/`admin_users`.

### 4. Configurar variables de entorno

```bash
cp app/.env.example app/.env      # editar con los valores reales
cp .env.example .env              # ULTRA SECRETO: service_role; solo local admin
```

### 5. Levantar el frontend

```bash
cd app
npm install
npm run dev       # http://localhost:5173
```

### 6. Desplegar Edge Functions

```bash
supabase functions deploy create-user
supabase functions deploy delete-user
```

## Seguridad aplicada

- **Auth real** con Supabase; sin comparación de contraseñas en JavaScript ni
  claves hardcodeadas. Cada usuario tiene su propia clave (mín. 8 caracteres).
- **Row Level Security en todas las tablas** (ver `0002_rls.sql`):
  - Anónimos: nada.
  - Conductor: solo sus propios `trips`, y solo mientras NO estén `finalizado`
    (además lo protege un trigger `prevent_edit_finalized_trip`). Sin acceso a
    `tarifas`, `contracts`, `clients` ni datos de otros conductores.
  - Admin: lectura/escritura de maestras y reportes globales.
  - RUT/email: `clients.rut`, `drivers.rut/email` y `admin_users.email` quedan
    restringidos por las policies; el conductor solo ve su propio perfil vía la
    función `my_profile()`. Cumple la Ley 19.628 (acceso mínimo).
- **Cálculo de montos en el servidor** (`calculate_trip_amounts` / `finalize_trip`,
  migración `0003_functions.sql`): valida la tarifa vigente para el contrato **a la
  fecha del inicio del viaje** (historial versionado en `tarifas`). El navegador solo
  muestra una vista previa; el valor autoritativo lo fija Postgres al cerrar el viaje.
- **XSS**: todos los textos de usuario pasan por `esc()` (`lib.js`) antes de inyectarse.
- **Storage privado**: bucket `contracts-pdf` (`public = false`); descargas solo por
  URLs firmadas de corta duración (`createSignedUrl`).
- **Auditoría** (`audit_log`): logins/logouts, creación de usuarios,
  cambios de contratos y tarifas (vía trigger automático) y exportaciones de reportes.

## Git y GitHub

- El `.gitignore` ya excluye `node_modules`, `dist`, `.env`, `app/.env` y `.env.*`.
- Crea el repo privado en GitHub y asocialo localmente:
  ```bash
  # desde transportes-diaz/
  git init
  git add .
  git commit -m "Migración a Supabase: esquema, RLS, funciones y frontend"
  git branch -M main
  git remote add origin https://github.com/TU_USUARIO/transportes-diaz.git
  git push -u origin main
  ```

> ⚠️ Antes del primer push: verifica que `git status` no liste ningún `.env` ni clave.

## Pendientes de probar (con proyecto real)

1. Ejecutar las 4 migraciones sin errores y revisar que RLS bloquea accesos anónimos.
2. Login conductor/admin de extremo a extremo y asignación de rol por `app_metadata`.
3. Flujo completo de un viaje: inicio → espera → finalización, y que el monto final
   provenga siempre de `finalize_trip()` con la tarifa vigente.
4. Intentos prohibidos: un conductor NO puede leer `tarifas`/`contracts`, ni editar un
   viaje ajeno o finalizado (verificar con distintas sesiones).
5. Subida/descarga de PDF con URLs firmadas y vencimiento.
6. `audit_log` capturando login, ediciones de tarifas/contratos y exportaciones.
7. Exportación Excel y creación de usuarios desde el backoffice.
8. Build de producción: `npm run build` y `npm run preview` con el `.env` real.

## Pendientes para producción (no bloqueantes)

- Reemplazar la simulación GPS del ticker por telemetría real (el frontend hoy
  persiste km/espera; el monto final igualmente lo valida el servidor).
- Enviar invitación por correo (Supabase email) en vez de entregar clave temporal.
- Tarea programada (cron de Edge Function o `pg_cron`) para reportes semanales/mensuales.
- Restringir la lectura de cada PDF al contrato del viaje del conductor (hoy cualquier
  conductor activo puede firmar URL de cualquier PDF del bucket).