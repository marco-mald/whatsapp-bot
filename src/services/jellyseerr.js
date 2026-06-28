const axios = require('axios');

const client = axios.create({
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

function getHeaders() {
  return { 'X-Api-Key': process.env.JELLYSEERR_API_KEY };
}

function base() {
  return process.env.JELLYSEERR_URL;
}

async function search(query) {
  const res = await client.get(`${base()}/api/v1/search`, {
    headers: getHeaders(),
    params: { query: encodeURIComponent(query), page: 1 },
  });
  return res.data.results.filter(
    (r) => r.mediaType === 'movie' || r.mediaType === 'tv'
  );
}

async function requestMedia(mediaType, mediaId, userId = null) {
  const body = { mediaType, mediaId, is4k: false };
  if (mediaType === 'tv') body.seasons = 'all';
  if (userId) body.userId = userId;
  const res = await client.post(`${base()}/api/v1/request`, body, {
    headers: getHeaders(),
  });
  return res.data;
}

async function findUserByUsername(username) {
  const res = await client.get(`${base()}/api/v1/user`, {
    headers: getHeaders(),
    params: { take: 100, skip: 0 },
  });
  const users = res.data.results || [];
  const lower = username.toLowerCase();
  return (
    users.find((u) => u.username?.toLowerCase() === lower) ||
    users.find((u) => u.email?.toLowerCase() === lower) ||
    null
  );
}

async function getTrending() {
  const res = await client.get(`${base()}/api/v1/discover/trending`, {
    headers: getHeaders(),
    params: { page: 1 },
  });
  return res.data.results.slice(0, 3);
}

module.exports = { search, requestMedia, getTrending, findUserByUsername };
