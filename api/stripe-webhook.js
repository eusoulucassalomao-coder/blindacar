// POST /api/stripe-webhook  — Stripe avisa aqui quando o pagamento foi concluído.
// Verifica a assinatura e libera has_access no perfil do usuário.
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    const buf = await rawBody(req);
    event = stripe.webhooks.constructEvent(buf, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('bad signature', e.message);
    return res.status(400).send('invalid signature');
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    if (s.payment_status === 'paid' && s.client_reference_id) {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });
      const { error } = await sb.from('profiles').update({
        has_access: true,
        paid_at: new Date().toISOString(),
        stripe_customer_id: typeof s.customer === 'string' ? s.customer : null,
        stripe_session_id: s.id,
      }).eq('id', s.client_reference_id);
      if (error) {
        console.error('db error', error);
        return res.status(500).send('db error'); // Stripe tentará de novo
      }
    }
  }
  return res.status(200).json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
