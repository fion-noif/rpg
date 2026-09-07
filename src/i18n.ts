export type Lang = 'en' | 'es';

export const strings = {
  en: {
    customer: 'Customer',
    selectCustomer: 'Select customer',
    searchParts: 'Search parts',
    addParts: 'Add parts',
    popularParts: 'Popular parts',
    allParts: 'All parts',
    quantity: 'Quantity',
    add: 'Add',
    remove: 'Remove',
    partsUsedFor: 'Parts used by',
    nothingRecorded: 'Nothing recorded yet',
    removeEntry: 'Remove',
    recordedBy: 'by',
    // No `manager:` key any more (M3). Attribution for an admin line is the admin's real
    // name off their staff row, which is data, not a translatable label — a person's name
    // reads the same in both languages. Pre-M3 rows are literally named 'Manager'.
    saveFailed: 'Could not save — please try again',
    // Shown instead of saveFailed when the write was refused because the manager already
    // approved this customer: retrying will never help, so say why (plan §8).
    tabLocked: 'This customer’s parts have been approved — no more changes',
    pending: 'Saving…',
    confirmed: 'Saved',
    offlineNote: 'Saved on this phone — will send when connection returns',
    noResults: 'No parts found',
    noSession: 'This link is not valid. Ask your manager for your personal link.',
    // Distinct from noSession because the remedy is different: the link was real, the
    // weekend is over, and only the manager can extend it or issue a new one (M4).
    linkExpired:
      'This link has expired — the event has ended. Ask your manager if you still need access.',
  },
  es: {
    customer: 'Cliente',
    selectCustomer: 'Seleccionar cliente',
    searchParts: 'Buscar piezas',
    addParts: 'Añadir piezas',
    popularParts: 'Piezas frecuentes',
    allParts: 'Todas las piezas',
    quantity: 'Cantidad',
    add: 'Añadir',
    remove: 'Eliminar',
    partsUsedFor: 'Piezas utilizadas por',
    nothingRecorded: 'Aún no hay nada registrado',
    removeEntry: 'Eliminar',
    recordedBy: 'por',
    saveFailed: 'No se pudo guardar — intenta de nuevo',
    tabLocked: 'Las piezas de este cliente ya fueron aprobadas — no se pueden cambiar',
    pending: 'Guardando…',
    confirmed: 'Guardado',
    offlineNote: 'Guardado en este teléfono — se enviará cuando vuelva la conexión',
    noResults: 'No se encontraron piezas',
    noSession: 'Este enlace no es válido. Pide a tu gerente tu enlace personal.',
    linkExpired:
      'Este enlace ha caducado — el evento ya terminó. Pide acceso a tu gerente si aún lo necesitas.',
  },
} as const;

export type Strings = (typeof strings)['en'];
