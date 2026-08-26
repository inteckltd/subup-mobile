// Stripe Account Links only accept https return/refresh URLs. This
// public redirect sends the in-app browser back to subup:// so
// WebBrowser.openAuthSessionAsync can close.

const ALLOWED = new Set(['return', 'refresh']);

Deno.serve((req) => {
  const url = new URL(req.url);
  const to = url.searchParams.get('to') ?? 'return';
  const target = ALLOWED.has(to) ? to : 'return';
  return new Response(null, {
    status: 302,
    headers: {
      Location: `subup://stripe-connect/${target}`,
    },
  });
});
