/** Native browser dialogs are disabled by MCP App hosts; keep approval inside the workbench. */
export function showWorkbenchDialog(message: string, initial?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog"),
      form = document.createElement("form"),
      label = document.createElement("p");
    dialog.setAttribute("aria-label", message);
    dialog.className = "bg-background text-foreground border border-border rounded-lg shadow-xl";
    dialog.style.cssText = "padding:24px;max-width:min(560px,90vw);";
    form.method = "dialog";
    label.textContent = message;
    label.style.cssText = "white-space:pre-wrap;margin:0 0 16px";
    form.append(label);
    let input: HTMLInputElement | undefined;
    if (initial !== undefined) {
      input = document.createElement("input");
      input.value = initial;
      input.setAttribute("aria-label", message);
      input.className = "bg-background border border-border rounded px-2 py-1 w-full";
      form.append(input);
    }
    const actions = document.createElement("div"),
      cancel = document.createElement("button"),
      confirm = document.createElement("button");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:12px;margin-top:16px";
    const chinese = document.documentElement.lang.startsWith("zh");
    cancel.type = "button";
    cancel.textContent = chinese ? "取消" : "Cancel";
    cancel.dataset.cancel = "";
    confirm.type = "submit";
    confirm.textContent = chinese ? "确定" : "OK";
    confirm.dataset.confirm = "";
    for (const button of [cancel, confirm]) {
      button.className = "border border-border rounded px-3 py-1";
      actions.append(button);
    }
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(input?.value ?? "");
    });
    form.append(actions);
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    (input ?? cancel).focus();
  });
}
export async function confirmWorkbench(message: string): Promise<boolean> {
  if (!import.meta.env.VITE_DBX_CODEX_APP) return window.confirm(message);
  return (await showWorkbenchDialog(message)) !== null;
}
export async function promptWorkbench(message: string, initial = ""): Promise<string | null> {
  if (!import.meta.env.VITE_DBX_CODEX_APP) return window.prompt(message, initial);
  return showWorkbenchDialog(message, initial);
}
