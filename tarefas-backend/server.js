require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const AUTH_SECRET = process.env.AUTH_SECRET || 'change-this-secret-in-production';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const CHALLENGE_TTL_SECONDS = 10 * 60;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_INTERVAL_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const OTP_EMAIL_FROM = process.env.OTP_EMAIL_FROM || '';

app.use(cors());
app.use(express.json());

if (!MONGODB_URI) {
  throw new Error('MONGODB_URI nao definido. Configura tarefas-backend/.env antes de iniciar o servidor.');
}

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('MongoDB conectado'))
  .catch((err) => console.error('Erro ao conectar MongoDB:', err));

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    otpCodeHash: { type: String, default: '' },
    otpCodeExpiresAt: { type: Date, default: null },
    otpAttemptsLeft: { type: Number, default: 0 },
    otpLastSentAt: { type: Date, default: null },
    otpPurpose: { type: String, default: '' },
  },
  { timestamps: true }
);

const tarefaSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    texto: { type: String, required: true, trim: true },
    concluida: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);
const Tarefa = mongoose.model('Tarefa', tarefaSchema);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [salt, storedHash] = passwordHash.split(':');
  if (!salt || !storedHash) return false;

  const derivedHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(derivedHash, 'hex'));
}

function signPayload(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function readSignedPayload(token) {
  if (!token || !token.includes('.')) return null;

  const [encodedPayload, signature] = token.split('.');
  const expectedSignature = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(encodedPayload)
    .digest('base64url');

  if (signature !== expectedSignature) return null;

  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

function createSessionToken(user) {
  return signPayload({
    type: 'session',
    sub: user._id.toString(),
    username: user.username,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  });
}

function createChallengeToken(user, purpose) {
  return signPayload({
    type: 'challenge',
    sub: user._id.toString(),
    purpose,
    exp: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS,
  });
}

function verifySessionToken(token) {
  const payload = readSignedPayload(token);
  if (!payload || payload.type !== 'session') return null;
  return payload;
}

function verifyChallengeToken(token) {
  const payload = readSignedPayload(token);
  if (!payload || payload.type !== 'challenge') return null;
  return payload;
}

function hashOtpCode(code) {
  return crypto.createHash('sha256').update(`${code}:${AUTH_SECRET}`).digest('hex');
}

function generateOtpCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;

  const visibleLocal = local.slice(0, 2);
  const hiddenLocal = '*'.repeat(Math.max(local.length - 2, 1));
  return `${visibleLocal}${hiddenLocal}@${domain}`;
}

function getSafeUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
  };
}

async function sendOtpByEmail(target, code, purpose) {
  if (!RESEND_API_KEY || !OTP_EMAIL_FROM) return { delivered: false };

  const subject =
    purpose === 'password_reset' ? 'Codigo para recuperar a password' : 'Codigo de seguranca';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: OTP_EMAIL_FROM,
      to: [target],
      subject,
      html:
        purpose === 'password_reset'
          ? `<p>O teu codigo para redefinir a password e <strong>${code}</strong>.</p><p>Expira em 10 minutos.</p>`
          : `<p>O teu codigo de seguranca e <strong>${code}</strong>.</p><p>Expira em 10 minutos.</p>`,
    }),
  });

  if (!response.ok) {
    throw new Error('Falha ao enviar codigo por email');
  }

  return { delivered: true };
}

async function issueOtpChallenge(user, purpose) {
  if (
    user.otpLastSentAt &&
    Date.now() - user.otpLastSentAt.getTime() < OTP_RESEND_INTERVAL_MS
  ) {
    return {
      erro: 'Espera alguns segundos antes de pedir um novo codigo',
      status: 429,
    };
  }

  const code = generateOtpCode();
  user.otpCodeHash = hashOtpCode(code);
  user.otpCodeExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  user.otpAttemptsLeft = OTP_MAX_ATTEMPTS;
  user.otpLastSentAt = new Date();
  user.otpPurpose = purpose;
  await user.save();

  const delivery = await sendOtpByEmail(user.email, code, purpose).catch(() => ({ delivered: false }));

  if (!delivery.delivered) {
    console.log(`[OTP email] ${user.email}: ${code}`);
  }

  return {
    requiresOtp: true,
    purpose,
    challengeToken: createChallengeToken(user, purpose),
    maskedDestination: maskEmail(user.email),
    devCode: delivery.delivered ? undefined : code,
  };
}

async function validateOtpForPurpose(user, code, purpose) {
  if (!user.otpCodeHash || !user.otpCodeExpiresAt || user.otpPurpose !== purpose) {
    return { ok: false, status: 400, erro: 'Nao existe nenhum codigo ativo para esta operacao' };
  }

  if (user.otpCodeExpiresAt.getTime() < Date.now()) {
    user.otpCodeHash = '';
    user.otpCodeExpiresAt = null;
    user.otpAttemptsLeft = 0;
    user.otpPurpose = '';
    await user.save();
    return { ok: false, status: 400, erro: 'O codigo expirou. Pede um novo codigo' };
  }

  if (user.otpAttemptsLeft <= 0) {
    return { ok: false, status: 429, erro: 'Demasiadas tentativas. Pede um novo codigo' };
  }

  const submittedHash = hashOtpCode(code);
  if (submittedHash !== user.otpCodeHash) {
    user.otpAttemptsLeft -= 1;
    await user.save();
    return {
      ok: false,
      status: 401,
      erro:
        user.otpAttemptsLeft > 0
          ? `Codigo invalido. Restam ${user.otpAttemptsLeft} tentativas`
          : 'Codigo invalido. Pede um novo codigo',
    };
  }

  user.otpCodeHash = '';
  user.otpCodeExpiresAt = null;
  user.otpAttemptsLeft = 0;
  user.otpPurpose = '';
  await user.save();

  return { ok: true };
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const payload = verifySessionToken(token);

    if (!payload?.sub) {
      return res.status(401).json({ erro: 'Sessao invalida' });
    }

    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ erro: 'Utilizador nao encontrado' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Falha na autenticacao' });
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', mensagem: 'Servidor backend ativo' });
});

app.post('/auth/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (username.length < 3) {
      return res.status(400).json({ erro: 'O username deve ter pelo menos 3 caracteres' });
    }

    if (!email.includes('@')) {
      return res.status(400).json({ erro: 'Email invalido' });
    }

    if (password.length < 6) {
      return res.status(400).json({ erro: 'A password deve ter pelo menos 6 caracteres' });
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    });

    if (existingUser) {
      return res.status(409).json({ erro: 'Ja existe uma conta com esse email ou username' });
    }

    const user = await User.create({
      username,
      email,
      passwordHash: hashPassword(password),
    });

    const challenge = await issueOtpChallenge(user, 'register');
    if (challenge.erro) {
      await User.findByIdAndDelete(user._id);
      return res.status(challenge.status).json({ erro: challenge.erro });
    }

    return res.status(201).json(challenge);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar conta' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    const user = await User.findOne({ email });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ erro: 'Credenciais invalidas' });
    }

    const challenge = await issueOtpChallenge(user, 'login');
    if (challenge.erro) {
      return res.status(challenge.status).json({ erro: challenge.erro });
    }

    return res.json(challenge);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao iniciar sessao' });
  }
});

app.post('/auth/otp/resend', async (req, res) => {
  try {
    const challengeToken = req.body.challengeToken || '';
    const payload = verifyChallengeToken(challengeToken);

    if (!payload?.sub || !payload.purpose) {
      return res.status(401).json({ erro: 'Pedido de codigo invalido' });
    }

    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(404).json({ erro: 'Utilizador nao encontrado' });
    }

    const challenge = await issueOtpChallenge(user, payload.purpose);
    if (challenge.erro) {
      return res.status(challenge.status).json({ erro: challenge.erro });
    }

    return res.json(challenge);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao reenviar codigo' });
  }
});

app.post('/auth/otp/verify', async (req, res) => {
  try {
    const challengeToken = req.body.challengeToken || '';
    const code = String(req.body.code || '').trim();
    const payload = verifyChallengeToken(challengeToken);

    if (!payload?.sub || !payload.purpose) {
      return res.status(401).json({ erro: 'Pedido de validacao invalido' });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ erro: 'Indica um codigo de 6 digitos' });
    }

    if (!['login', 'register'].includes(payload.purpose)) {
      return res.status(400).json({ erro: 'Este codigo nao serve para abrir sessao' });
    }

    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(404).json({ erro: 'Utilizador nao encontrado' });
    }

    const validation = await validateOtpForPurpose(user, code, payload.purpose);
    if (!validation.ok) {
      return res.status(validation.status).json({ erro: validation.erro });
    }

    return res.json({
      token: createSessionToken(user),
      user: getSafeUser(user),
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao validar codigo' });
  }
});

app.post('/auth/password/forgot', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email.includes('@')) {
      return res.status(400).json({ erro: 'Email invalido' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ erro: 'Nao existe nenhuma conta com esse email' });
    }

    const challenge = await issueOtpChallenge(user, 'password_reset');
    if (challenge.erro) {
      return res.status(challenge.status).json({ erro: challenge.erro });
    }

    return res.json(challenge);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao iniciar recuperacao da password' });
  }
});

app.post('/auth/password/reset', async (req, res) => {
  try {
    const challengeToken = req.body.challengeToken || '';
    const code = String(req.body.code || '').trim();
    const password = req.body.password || '';
    const payload = verifyChallengeToken(challengeToken);

    if (!payload?.sub || payload.purpose !== 'password_reset') {
      return res.status(401).json({ erro: 'Pedido de recuperacao invalido' });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ erro: 'Indica um codigo de 6 digitos' });
    }

    if (password.length < 6) {
      return res.status(400).json({ erro: 'A nova password deve ter pelo menos 6 caracteres' });
    }

    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(404).json({ erro: 'Utilizador nao encontrado' });
    }

    const validation = await validateOtpForPurpose(user, code, 'password_reset');
    if (!validation.ok) {
      return res.status(validation.status).json({ erro: validation.erro });
    }

    user.passwordHash = hashPassword(password);
    await user.save();

    return res.json({ message: 'Password atualizada com sucesso' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao redefinir a password' });
  }
});

app.get('/auth/me', requireAuth, async (req, res) => {
  return res.json({ user: getSafeUser(req.user) });
});

app.delete('/auth/me', requireAuth, async (req, res) => {
  try {
    await Tarefa.deleteMany({ userId: req.user._id });
    await User.findByIdAndDelete(req.user._id);
    return res.json({ message: 'Conta removida' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao remover conta' });
  }
});

app.get('/tarefas', requireAuth, async (req, res) => {
  try {
    const tarefas = await Tarefa.find({ userId: req.user._id }).sort({ createdAt: -1 });
    return res.json(tarefas);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao carregar tarefas' });
  }
});

app.post('/tarefas', requireAuth, async (req, res) => {
  try {
    const texto = (req.body.texto || '').trim();
    if (!texto) {
      return res.status(400).json({ erro: 'A tarefa nao pode estar vazia' });
    }

    const tarefa = await Tarefa.create({
      userId: req.user._id,
      texto,
      concluida: false,
    });

    return res.status(201).json(tarefa);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar tarefa' });
  }
});

app.patch('/tarefas/:id', requireAuth, async (req, res) => {
  try {
    const tarefa = await Tarefa.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa nao encontrada' });
    }

    if (typeof req.body.texto === 'string') {
      const texto = req.body.texto.trim();
      if (!texto) {
        return res.status(400).json({ erro: 'A tarefa nao pode estar vazia' });
      }
      tarefa.texto = texto;
    }

    if (typeof req.body.concluida === 'boolean') {
      tarefa.concluida = req.body.concluida;
    }

    await tarefa.save();
    return res.json(tarefa);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar tarefa' });
  }
});

app.put('/tarefas/:id', requireAuth, async (req, res) => {
  try {
    const tarefa = await Tarefa.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa nao encontrada' });
    }

    tarefa.concluida = !tarefa.concluida;
    await tarefa.save();
    return res.json(tarefa);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar tarefa' });
  }
});

app.delete('/tarefas/:id', requireAuth, async (req, res) => {
  try {
    const tarefa = await Tarefa.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa nao encontrada' });
    }

    return res.json({ message: 'Apagada' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao apagar tarefa' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
