/* KasirPro AT-11 launcher — professional dialog + supplier display */
import '../app-dialog.js';

/* Capture professional confirm/prompt before legacy POS handlers register. */
import './pos-dialog-actions-at08.js';

/* Stable POS core. */
import './pos-at07-core.js';

/* AT-11 display-only enhancement: company supplier name in quick search results. */
import './pos-supplier-display-at11.js';

