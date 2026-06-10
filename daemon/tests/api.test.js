const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const BASE_URL = 'http://127.0.0.1:8787';

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        data: data ? JSON.parse(data) : null
      }));
    }).on('error', reject);
  });
}

test('API Health Check', async (t) => {
  try {
    const res = await get('/health');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.data.hasOwnProperty('clients'));
    assert.ok(res.data.hasOwnProperty('pendingPerms'));
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      t.skip('Daemon not running at 127.0.0.1:8787');
    } else {
      throw err;
    }
  }
});

test('Roster API Check', async (t) => {
  try {
    const res = await get('/registry');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.data.hasOwnProperty('agents'));
    assert.ok(res.data.agents.hasOwnProperty('main'));
    assert.ok(res.data.agents.hasOwnProperty('ceo'));
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      t.skip('Daemon not running at 127.0.0.1:8787');
    } else {
      throw err;
    }
  }
});

test('Version API Check', async (t) => {
  try {
    const res = await get('/version');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.data.hasOwnProperty('version'));
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      t.skip('Daemon not running at 127.0.0.1:8787');
    } else {
      throw err;
    }
  }
});
