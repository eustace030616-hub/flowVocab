"use client";

/**
 * The sign-in form.
 *
 * Rendered by the server when there is no session, so it is in the HTML rather than assembled by
 * client JavaScript afterwards. That distinction matters: the first version put the gate in the
 * client, and a phone holding a cached bundle simply never showed it — the page came up as the app
 * with every control disabled, which reads as a broken app rather than as a sign-in screen.
 *
 * Dev stage: any name, any password. No email, no confirmation, no reset. The server still salts and
 * hashes the password, because the same door ships later.
 */
import { useState } from "react";

const COPY = {
  en: {
    title: "Sign in",
    hint: "Any name, any password — this is a dev build.",
    name: "Name",
    password: "Password",
    signIn: "Sign in",
    create: "Create account",
    failed: "Wrong name or password.",
    taken: "That name is taken.",
  },
  zh: {
    title: "登录",
    hint: "任意名称、任意密码 — 这是开发版本。",
    name: "名称",
    password: "密码",
    signIn: "登录",
    create: "创建账号",
    failed: "名称或密码错误。",
    taken: "该名称已被占用。",
  },
};

export default function AuthGate({ locale = "en" }: { locale?: "en" | "zh" }) {
  const t = COPY[locale];
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (mode: "login" | "register") => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: name, password }),
    });
    if (!res.ok) {
      setBusy(false);
      setError(res.status === 409 ? t.taken : t.failed);
      return;
    }
    // A full load rather than a state change: the page was rendered by the server as unauthenticated,
    // so the only way to get the authenticated one is to ask again.
    window.location.replace("/");
  };

  return (
    <div className="h-dvh flex flex-col bg-white text-zinc-900 antialiased">
      <main className="flex-1 flex items-center justify-center px-6">
        <form
          className="w-full max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void submit("login");
          }}
        >
          <h1 className="text-lg font-medium tracking-tight text-zinc-900">{t.title}</h1>
          <p className="text-xs text-zinc-400 mt-1">{t.hint}</p>

          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="text-xs text-zinc-500">{t.name}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                className="mt-1 w-full h-10 px-3 text-sm border fv-hairline bg-white focus:outline-none focus:border-zinc-900"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500">{t.password}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="mt-1 w-full h-10 px-3 text-sm border fv-hairline bg-white focus:outline-none focus:border-zinc-900"
              />
            </label>
          </div>

          {error && <p className="mt-3 text-xs text-swiss">{error}</p>}

          <div className="mt-6 flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !name.trim() || !password}
              className="h-10 flex-1 text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40"
            >
              {t.signIn}
            </button>
            <button
              type="button"
              disabled={busy || !name.trim() || !password}
              onClick={() => void submit("register")}
              className="h-10 px-4 text-sm font-medium border fv-hairline text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              {t.create}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
