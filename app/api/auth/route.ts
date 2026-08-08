import { NextRequest, NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth";

export async function POST(req: NextRequest) {
    const { password } = await req.json();

    if (password !== process.env.AUTH_PASSWORD) {
        return NextResponse.json({ error: "Invalid password." }, { status: 401 });
    }

    const token = await hashPassword(process.env.AUTH_PASSWORD!, process.env.AUTH_SECRET!);

    const res = NextResponse.json({ success: true });
    res.cookies.set("warrant_session", token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return res;
}