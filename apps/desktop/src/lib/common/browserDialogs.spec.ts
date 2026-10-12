// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { showWorkbenchDialog } from "./browserDialogs";
describe("Workbench dialogs in a sandbox", () => {
  it("waits for explicit confirmation and preserves typed prompt text", async () => {
    const answer = showWorkbenchDialog("Confirm change", "");
    const dialog = document.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe("Confirm change");
    const input = dialog.querySelector("input")!;
    input.value = "user typed";
    (dialog.querySelector("[data-confirm]") as HTMLButtonElement).click();
    await expect(answer).resolves.toBe("user typed");
    expect(document.querySelector("dialog")).toBeNull();
  });
  it("returns null on cancellation without approving the operation", async () => {
    const answer = showWorkbenchDialog("Delete connection");
    (document.querySelector("[data-cancel]") as HTMLButtonElement).click();
    await expect(answer).resolves.toBeNull();
  });
});
