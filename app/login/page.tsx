"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const router = useRouter();
    const searchParams = useSearchParams();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const res = await fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
        });

        if (res.ok) {
            const dest = searchParams.get("from") || "/";
            router.push(dest);
            router.refresh();
        } else {
            setError("Incorrect password.");
            setLoading(false);
        }
    };

    return (
        <div className="h-[100dvh] bg-black text-neutral-200 flex items-center justify-center px-4">
            <form
                onSubmit={handleSubmit}
                className="w-full max-w-sm rounded-xl border border-neutral-800/60 bg-neutral-950 p-6 space-y-4"
            >
                <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-lg bg-yellow-400 flex items-center justify-center glow-yellow">
                        <span className="text-black font-bold font-mono text-sm">W</span>
                    </div>
                    <div>
                        <div className="text-sm font-bold text-neutral-100 font-mono uppercase tracking-wider">
                            Warrant
                        </div>
                        <div className="text-[10px] text-neutral-600 font-mono uppercase tracking-wider">
                            Restricted access
                        </div>
                    </div>
                </div>

                <div className="space-y-1.5">
                    <label className="text-xs text-neutral-600 font-mono uppercase tracking-wider">
                        Password
                    </label>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoFocus
                        className="w-full rounded-lg bg-black border border-neutral-800/60 px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-yellow-400/60 transition-colors font-mono"
                    />
                </div>

                {error && <div className="text-xs text-red-500 font-mono">{error}</div>}

                <button
                    type="submit"
                    disabled={loading || !password}
                    className="w-full py-2 rounded-lg bg-yellow-400 border border-yellow-400 text-black text-sm font-bold uppercase tracking-wider hover:bg-yellow-300 active:scale-[0.98] transition-all disabled:opacity-40 font-mono glow-yellow"
                >
                    {loading ? "Checking..." : "Enter"}
                </button>
            </form>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={null}>
            <LoginForm />
        </Suspense>
    );
}