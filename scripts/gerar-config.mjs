// Gera web/config.js a partir das variáveis de ambiente (roda no build da Vercel).
// Aceita os nomes usados pela integração oficial Supabase ↔ Vercel (NEXT_PUBLIC_...).
import fs from 'fs';
import path from 'path';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Faltam as variáveis SUPABASE_URL e SUPABASE_ANON_KEY (Vercel → Settings → Environment Variables).');
  process.exit(1);
}
// A chave "anon" é pública por definição: o acesso aos dados é protegido pelo RLS do banco.
const out = path.join(import.meta.dirname, '..', 'web', 'config.js');
fs.writeFileSync(out, `window.APP_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key })};\n`);
console.log('web/config.js gerado');
