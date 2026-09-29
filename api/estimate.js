// 食事のカロリー推定API。Vercel上で動き、Claude APIのキーはサーバー側の環境変数にだけ置く。
//
// 必要な環境変数（Vercelの Settings → Environment Variables）
//   ANTHROPIC_API_KEY  Claude APIのキー
//   APP_KEY            アプリ側で入力する「合言葉」。これが無い人はAPIを使えない
//   CLAUDE_MODEL       （任意）使うモデル。省略すると claude-opus-5-5
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_TEXT = 500;
const MAX_IMAGE_BASE64 = 4_000_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const SYSTEM = `あなたは日本の管理栄養士です。ユーザーが食べたもの（文章や料理の写真）から、品目ごとのエネルギー(kcal)とたんぱく質p・脂質f・炭水化物c(g)を推定します。
- 量の指定がなければ、日本の一般的な1人前で推定する
- 店名や商品名があれば、その公表値に近い値にする
- 定食やセットは、主な品目に分けて出力する
- 写真の場合は、写っている料理と量を見て推定する
- itemsのnameには、品目名と想定した量を入れる（例：カツ丼 大盛り）
- noteには、推定の前提や不確かな点を日本語で1文で書く`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kcal: { type: "number" },
          p: { type: "number" },
          f: { type: "number" },
          c: { type: "number" },
        },
        required: ["name", "kcal", "p", "f", "c"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["items", "note"],
  additionalProperties: false,
};

function sameSecret(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function send(res, status, body) {
  res.status(status).json(body);
}

function buildContent(text, image) {
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } });
  content.push({ type: "text", text: text ? `食べたもの: ${text}` : "この写真の食事のカロリーを推定してください。" });
  return content;
}

// テストで差し替えられるよう、ハンドラはクライアントを受け取る形で作る
export function createHandler(getClient) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405, { error: "POSTだけ使えます" });
    }

    const appKey = process.env.APP_KEY;
    if (!appKey) return send(res, 500, { error: "サーバーの設定が終わっていません（APP_KEY）", code: "not_configured" });
    if (!sameSecret(req.headers["x-app-key"] ?? "", appKey)) {
      return send(res, 401, { error: "合言葉が違います", code: "unauthorized" });
    }

    const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
    const image = body?.image;
    if (image) {
      const ok = typeof image.data === "string" && image.data.length > 0 && image.data.length <= MAX_IMAGE_BASE64 && IMAGE_TYPES.includes(image.media_type);
      if (!ok) return send(res, 400, { error: "画像を読み込めませんでした", code: "bad_image" });
    }
    if (!text && !image) return send(res, 400, { error: "食べたものを入力してください", code: "bad_input" });

    const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
    const params = {
      model,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: buildContent(text, image) }],
    };
    // effortを受け付けないモデル（Haiku）以外は、単純な作業なので最小に下げる
    if (!model.startsWith("claude-haiku")) params.output_config.effort = "low";

    // 安全性の判定で断られたときに別モデルで再実行してもらう設定（既定のモデルのみ）
    const useFallback = model === DEFAULT_MODEL && process.env.CLAUDE_FALLBACK !== "off";

    try {
      const client = getClient();
      let response;
      if (useFallback) {
        try {
          response = await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
        } catch (e) {
          // フォールバック指定そのものが拒否された場合だけ、指定なしでやり直す
          if (!(e instanceof Anthropic.BadRequestError)) throw e;
          response = await client.messages.create(params);
        }
      } else {
        response = await client.messages.create(params);
      }

      if (response.stop_reason === "refusal") return send(res, 422, { error: "この内容は推定できませんでした。食べ物の内容を書き直してください", code: "refused" });
      if (response.stop_reason === "max_tokens") return send(res, 502, { error: "うまく読み取れませんでした。もう一度試してください", code: "truncated" });

      const block = response.content.find((b) => b.type === "text");
      const data = block ? safeParse(block.text) : null;
      if (!data || !Array.isArray(data.items)) return send(res, 502, { error: "うまく読み取れませんでした。もう一度試してください", code: "bad_output" });
      return send(res, 200, { items: data.items, note: typeof data.note === "string" ? data.note : "" });
    } catch (e) {
      console.error("estimate failed:", e?.status, e?.message);
      if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: "混み合っています。少し待ってからもう一度試してください", code: "rate_limited" });
      if (e instanceof Anthropic.AuthenticationError) return send(res, 500, { error: "サーバーのAPIキーが正しくありません（ANTHROPIC_API_KEY）", code: "not_configured" });
      if (e instanceof Anthropic.NotFoundError) return send(res, 500, { error: `モデルが見つかりません（${model}）`, code: "server" });
      if (e instanceof Anthropic.APIError) return send(res, 502, { error: "AIへの接続に失敗しました。あとでもう一度試してください", code: "server" });
      return send(res, 500, { error: "推定できませんでした", code: "server" });
    }
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

let client;
export default createHandler(() => (client ??= new Anthropic()));
