// Estado global de la sesión y navegación.
export const state = {
  user: null,          // usuario Supabase Auth
  role: null,          // 'conductor' | 'admin' (app_metadata.role)
  mode: 'gate',        // 'gate' | 'driver' | 'admin'
  missingRole: false,

  driverScreen: 'dashboard',
  adminScreen: 'clientes',

  // Datos del conductor (cargados una vez por sesión vía get_driver_context)
  driverContext: null,
  activeTrip: null,    // ingreso del viaje en curso (de la tabla trips)
  newTrip: {},         // armado de nuevo viaje

  editingContractId: null,
  uploadFile: null,    // PDF elegido en el form de contrato
  filters: {},
};