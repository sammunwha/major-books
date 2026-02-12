exports.handler = async (event) => {
  try {
    const q = (event.queryStringParameters?.q || "").trim();

    if (!q) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing q" }),
      };
    }

    if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing NAVER API env vars" }),
      };
    }

    const apiUrl = new URL("https://openapi.naver.com/v1/search/book.json");
    apiUrl.searchParams.set("query", q);
    apiUrl.searchParams.set("display", "10");
    apiUrl.searchParams.set("sort", "sim");

    const r = await fetch(apiUrl.toString(), {
      headers: {
        "X-Naver-Client-Id": process.env.NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": process.env.NAVER_CLIENT_SECRET,
      },
    });

    const text = await r.text();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: text,
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error", detail: String(e) }),
    };
  }
};
