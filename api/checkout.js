// POST /api/checkout  (header Authorization: Bearer <access_token do Supabase>)
// Cria uma sessão do Stripe Checkout (pagamento único) para o usuário autenticado.
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'no_token' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'invalid_token' });

    const { data: profile } = await sb.from('profiles').select('has_access').eq('id', user.id).maybeSingle();
    if (profile && profile.has_access) return res.status(200).json({ already: true });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const origin = process.env.APP_URL || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: user.id,      // o webhook usa isto para liberar o acesso
      customer_email: user.email,
      success_url: `${origin}/?paid=1`,
      cancel_url: `${origin}/?canceled=1`,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('checkout error', e);
    return res.status(500).json({ error: 'server_error' });
  }
};
