// DOM helpers shared across modules.
export const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Native <dialog> opened via showModal() closes on Escape for free but NOT on
// backdrop click. A click event dispatched on the dialog element itself
// (vs. on a child) means the user clicked the backdrop: close. Children
// (inputs, buttons, text) stop propagation naturally because their click
// target is themselves. One listener per dialog, idempotent.
export function wireDialogOutsideClick(dialog) {
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}
