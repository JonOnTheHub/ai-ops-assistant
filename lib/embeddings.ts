import VoyageAI from "voyageai";

const voyage = new VoyageAI({ apiKey: process.env.VOYAGE_API_KEY! });

export async function embed(text: string): Promise<number[]> {
    const response = await voyage.embed({
        input: text,
        model: "voyage-3-lite",
    });

    const embedding = response.data?.[0]?.embedding;

    if (!embedding) {
        throw new Error("[embeddings] Voyage returned no embedding");
    }

    return embedding;
}