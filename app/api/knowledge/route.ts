import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { embed } from "@/lib/embeddings";

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
    try {
        const { content, source }: { content: string; source: string } =
            await req.json();

        if (!content || !source) {
            return NextResponse.json(
                { error: "content and source are required" },
                { status: 400 }
            );
        }

        // Chunk into ~500 word segments (same pattern as PaperBase)
        const words = content.split(/\s+/);
        const chunkSize = 500;
        const chunks: string[] = [];

        for (let i = 0; i < words.length; i += chunkSize) {
            chunks.push(words.slice(i, i + chunkSize).join(" "));
        }

        const results = [];

        for (const chunk of chunks) {
            const embedding = await embed(chunk);

            const { data, error } = await supabase
                .from("kb_documents")
                .insert({ content: chunk, embedding, source })
                .select()
                .single();

            if (error) throw new Error(error.message);
            results.push(data);
        }

        return NextResponse.json({
            success: true,
            chunks: results.length,
            source,
        });
    } catch (err) {
        console.error("[knowledge] upload error:", err);
        return NextResponse.json(
            { error: `Upload failed: ${String(err)}` },
            { status: 500 }
        );
    }
}

// Also backfill embeddings for seeded KB docs that have none
export async function GET() {
    try {
        const { data: docs, error } = await supabase
            .from("kb_documents")
            .select("id, content")
            .is("embedding", null);

        if (error) throw new Error(error.message);
        if (!docs || docs.length === 0) {
            return NextResponse.json({ message: "No docs need backfill" });
        }

        for (const doc of docs) {
            const embedding = await embed(doc.content);
            await supabase
                .from("kb_documents")
                .update({ embedding })
                .eq("id", doc.id);
        }

        return NextResponse.json({
            success: true,
            backfilled: docs.length,
        });
    } catch (err) {
        return NextResponse.json(
            { error: `Backfill failed: ${String(err)}` },
            { status: 500 }
        );
    }
}