const axios = require('axios');

let sid = null;

function base() {
  return process.env.QBIT_URL;
}

async function login() {
  const res = await axios.post(
    `${base()}/api/v2/auth/login`,
    `username=${encodeURIComponent(process.env.QBIT_USER)}&password=${encodeURIComponent(process.env.QBIT_PASS)}`,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 8000,
    }
  );

  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('Login fallido: no se recibió cookie de sesión');

  const sidCookie = setCookie.find((c) => c.startsWith('SID='));
  if (!sidCookie) throw new Error('Login fallido: SID no encontrado');

  sid = sidCookie.split(';')[0];
}

async function getTorrents() {
  if (!sid) await login();

  try {
    const res = await axios.get(`${base()}/api/v2/torrents/info`, {
      headers: { Cookie: sid },
      timeout: 8000,
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 403) {
      sid = null;
      await login();
      const res = await axios.get(`${base()}/api/v2/torrents/info`, {
        headers: { Cookie: sid },
        timeout: 8000,
      });
      return res.data;
    }
    throw err;
  }
}

module.exports = { getTorrents };
