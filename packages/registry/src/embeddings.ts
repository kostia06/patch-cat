const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBEDDING_DIM = 768;

export async function embedDescription(
  ai: Ai,
  text: string,
  options: { gatewayName?: string } = {},
): Promise<number[]> {
  if (!text.trim()) {
    throw new Error("embedDescription called with empty text");
  }

  const aiOptions = options.gatewayName ? { gateway: { id: options.gatewayName } } : undefined;
  const response = await ai.run(
    EMBEDDING_MODEL,
    { text },
    aiOptions as Parameters<Ai["run"]>[2],
  );
  const data = (response as { data: unknown }).data;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Workers AI embedding response had no data");
  }

  const first = data[0];
  let vec: number[];

  if (Array.isArray(first)) {
    vec = first as number[];
  } else if (typeof first === "number") {
    vec = data as number[];
  } else {
    throw new Error("Workers AI embedding response had unexpected shape");
  }

  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`expected ${EMBEDDING_DIM}-dim embedding, got ${vec.length}-dim`);
  }
  return vec;
}
