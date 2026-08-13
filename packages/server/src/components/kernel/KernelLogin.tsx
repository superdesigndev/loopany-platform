import { useState } from "react";
import { cx, ERROR, SURFACE } from "./styles";

const LABEL = "mt-4 mb-[5px] block";
const INPUT = "mt-[5px] block w-full border border-[#888] p-[9px]";

/** Shared-password sign-in. Rendered whenever the workspace API answers 401 -
 *  auth is API-driven, so open mode (gate off, no session) never sees it. */
export function KernelLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const res = await fetch("/api/auth/kernel-shared-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (!res.ok) { setError("Invalid email or password"); return; }
    window.location.reload();
  }

  return <main className={cx(SURFACE, "grid place-items-center")}>
    <form className="w-[340px] border border-[#999] bg-white p-6" onSubmit={submit}>
      <strong className="text-[18px]">LOOPANY KERNEL</strong>
      <p>Team task workspace</p>
      <label className={LABEL}>Email
        <input className={INPUT} autoFocus type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label className={LABEL}>Access password
        <input className={INPUT} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      {error && <p className={ERROR}>{error}</p>}
      <button className="w-full cursor-pointer bg-[#171717] p-2.5 text-white">Sign in</button>
    </form>
  </main>;
}
