/** Fill a one-time-code field the store already showed. Does not click a captcha or challenge control. */
export function otpFillScript(code: string): string {
  const value = JSON.stringify(code)
  return `(() => {
    const nodes = document.querySelectorAll('input[autocomplete="one-time-code"], input[name="otpCode"], input[name="code"], input[name="otp"]');
    const input = Array.from(nodes).find((node) => node instanceof HTMLInputElement && node.type !== "hidden" && !node.disabled);
    if (!(input instanceof HTMLInputElement)) return false;
    input.focus();
    input.value = ${value};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const controls = Array.from(document.querySelectorAll("button, input[type=submit]"));
    const submit = controls.find((node) => {
      const label = String(node.textContent || node.value || "").trim();
      if (/captcha|challenge|not a robot/i.test(label)) return false;
      return /\\b(verify|continue|submit)\\b/i.test(label);
    });
    if (submit && typeof submit.click === "function") submit.click();
    return true;
  })()`
}
