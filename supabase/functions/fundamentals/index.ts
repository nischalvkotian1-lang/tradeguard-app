import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface FundamentalData {
  symbol: string;
  marketCap: number | null;
  netIncome: number | null;
  totalDebt: number | null;
  totalEquity: number | null;
  debtToEquity: number | null;
  institutionalOwnershipPct: number | null;
  source: string;
  notFound?: boolean;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function tryFetch(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getCrumbAndCookie(): Promise<{ crumb: string; cookie: string } | null> {
  try {
    const cookieRes = await fetch("https://fc.yahoo.com", {
      redirect: "manual",
      headers: { "User-Agent": UA },
    });
    const cookie = cookieRes.headers.get("set-cookie") || "";
    if (!cookie) return null;

    const crumbUrl = "https://query2.finance.yahoo.com/v1/test/getcrumb";
    const crumbRes = await fetch(crumbUrl, {
      headers: { "User-Agent": UA, Cookie: cookie },
    });
    const crumb = await crumbRes.text();
    if (!crumb || crumb.length < 3) return null;
    return { crumb, cookie };
  } catch {
    return null;
  }
}

async function fetchQuoteSummary(symbol: string): Promise<any | null> {
  const modules = "price,summaryDetail,financialData,defaultKeyStatistics,institutionOwnership";
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

  for (const host of hosts) {
    const data = await tryFetch(
      `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`,
    );
    if (data?.quoteSummary?.result?.[0]) return data.quoteSummary.result[0];
  }

  const auth = await getCrumbAndCookie();
  if (auth) {
    for (const host of hosts) {
      const data = await tryFetch(
        `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`,
        { Cookie: auth.cookie },
      );
      if (data?.quoteSummary?.result?.[0]) return data.quoteSummary.result[0];
    }
  }

  return null;
}

async function fetchChartMeta(symbol: string): Promise<any | null> {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  for (const host of hosts) {
    const data = await tryFetch(
      `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
    );
    if (data?.chart?.result?.[0]) return data.chart.result[0];
  }
  return null;
}

function num(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === "object" ? v?.raw ?? v?.value : v;
  const parsed = Number(n);
  return Number.isFinite(parsed) ? parsed : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    let symbol: string;
    try {
      const body = await req.json();
      symbol = (body?.symbol ?? "").trim().toUpperCase();
    } catch {
      const url = new URL(req.url);
      symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
    }

    if (!symbol) {
      return new Response(
        JSON.stringify({ error: "Missing 'symbol' parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Always append .NS for NSE; fall back to .BO for BSE if NSE fails
    const candidates: string[] = [];
    if (symbol.includes(".")) {
      candidates.push(symbol);
    } else {
      candidates.push(`${symbol}.NS`, `${symbol}.BO`);
    }

    let summary: any = null;
    let chart: any = null;
    for (const sym of candidates) {
      [summary, chart] = await Promise.all([
        fetchQuoteSummary(sym),
        fetchChartMeta(sym),
      ]);
      if (summary || chart) break;
    }

    if (!summary && !chart) {
      return new Response(
        JSON.stringify({ symbol, notFound: true, source: "Unknown" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const price = summary?.price ?? chart?.meta ?? {};
    const financialData = summary?.financialData ?? {};
    const keyStats = summary?.defaultKeyStatistics ?? {};

    let marketCap = num(financialData.marketCap) ?? num(price.marketCap) ?? num(keyStats.enterpriseValue);
    if (marketCap == null && chart?.meta) {
      const mp = num(chart.meta.regularMarketPrice);
      const sh = num(chart.meta.sharesOutstanding);
      if (mp != null && sh != null) marketCap = mp * sh;
    }

    // Profitability: prefer netIncomeToCommon, fall back to operatingMargins
    let netIncome = num(financialData.netIncomeToCommon);
    if (netIncome == null) {
      const opMargin = num(financialData.operatingMargins);
      if (opMargin != null) {
        netIncome = opMargin > 0 ? 1 : -1;
      }
    }

    const totalDebt = num(financialData.totalDebt);
    const totalEquity = num(financialData.totalStockholderEquity) ?? num(keyStats.bookValue);

    let debtToEquity: number | null = null;
    if (totalDebt != null && totalEquity != null && totalEquity !== 0) {
      debtToEquity = totalDebt / totalEquity;
    } else {
      const deRaw = num(financialData.debtToEquity);
      if (deRaw != null) debtToEquity = deRaw / 100;
    }

    let institutionalOwnershipPct: number | null = null;
    const instHoldings = summary?.institutionOwnership?.ownershipList;
    if (Array.isArray(instHoldings) && instHoldings.length > 0) {
      const latest = instHoldings[instHoldings.length - 1];
      const reported = num(latest?.reportDate);
      const sharesOut = num(price?.sharesOutstanding) ?? num(keyStats?.sharesOutstanding);
      if (reported != null && sharesOut != null && sharesOut > 0) {
        institutionalOwnershipPct = (reported / sharesOut) * 100;
      }
    }
    if (institutionalOwnershipPct == null) {
      const heldPct = num(keyStats?.heldPercentInsiders) ?? num(keyStats?.heldPercentInstitutions);
      if (heldPct != null) institutionalOwnershipPct = heldPct * 100;
    }

    const data: FundamentalData = {
      symbol,
      marketCap,
      netIncome,
      totalDebt,
      totalEquity,
      debtToEquity,
      institutionalOwnershipPct,
      source: "Yahoo Finance (NSE/BSE)",
    };

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Failed to fetch fundamentals" }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
