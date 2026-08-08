import { NextRequest, NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/auth"];

export async function middleware(req: NextRequest) {
    const { pathname } = req.nextUrl;

    if (
        PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
        pathname.startsWith("/_next") ||
        pathname === "/favicon.ico"
    ) {
        return NextResponse.next();
    }

    const session = req.cookies.get("warrant_session")?.value;
    const expected = await hashPassword(
        process.env.AUTH_PASSWORD!,
        process.env.AUTH_SECRET!
    );

    if (session === expected) {
        return NextResponse.next();
    }

    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
}

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};