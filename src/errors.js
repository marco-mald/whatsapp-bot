// Turns a raw Error (CLI stack, API error, network failure) into a short,
// friendly WhatsApp message. Full technical detail still belongs in the logs —
// this is only what the user sees.

function friendlyError(err) {
  const haystack = `${err?.message || ''} ${err?.stderr || ''} ${err?.stdout || ''} ${err?.code || ''}`.toLowerCase();

  if (/credit balance|insufficient.*credit|billing|quota exceeded/.test(haystack)) {
    return '😅 Se acabaron los créditos de la API por ahora. Ya le avisé a Marco.';
  }
  if (/rate limit|429|overloaded|too many requests/.test(haystack)) {
    return '🚦 Ando saturado ahorita, dame un momento y vuelve a intentarlo.';
  }
  if (/timeout|timed out|etimedout/.test(haystack)) {
    return '⏱️ Me tardé demasiado en responder, intenta de nuevo porfa.';
  }
  if (/econnrefused|enotfound|network|fetch failed/.test(haystack)) {
    return '📡 No pude conectarme a un servicio del server, intenta en un ratito.';
  }
  return '❌ Algo salió mal de mi lado, intenta de nuevo en un momento.';
}

module.exports = { friendlyError };
