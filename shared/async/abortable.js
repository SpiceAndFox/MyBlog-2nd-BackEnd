// Use only around external computation with no repository writes. Even a
// transport that ignores AbortSignal must not retain its caller or deliver a
// late result into a cancelled application operation.
function abortable(work, signal) {
  if (!signal) return Promise.resolve().then(work);
  const reason = () => signal.reason || Object.assign(new Error("Operation aborted"), { name: "AbortError" });
  if (signal.aborted) return Promise.reject(reason());
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(reason()); };
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    Promise.resolve().then(() => {
      if (signal.aborted) throw reason();
      return work();
    }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

module.exports = { abortable };
