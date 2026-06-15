import express from './node_modules/express/index.js';
import http from 'http';

const app = express();
app.post('/api/chat', () => {});
app.get('/test', () => {});

// Use app._router (Express 4) or app.lazyrouter (Express 5)
console.log('Express version:', express ? 'loaded' : 'failed');
console.log('app._router:', typeof app._router);
console.log('app.lazyrouter:', typeof app.lazyrouter);
console.log('app.routes:', typeof app.routes);

// In Express 5, try to inspect via internal
if (app._router) {
  app._router.stack.forEach(r => {
    if (r.route) console.log('ROUTE:', r.route.path, JSON.stringify(r.route.methods));
  });
} else {
  console.log('No app._router - check if routes were registered');
}

// Also check if app.post returns the app
const ret = app.post('/another', () => {});
console.log('app.post returns:', typeof ret);
console.log('ret === app:', ret === app);

// Create a server and send a test request
const server = app.listen(0, async () => {
  const addr = server.address();
  const port = addr.port;
  
  // Test POST
  const options = {
    hostname: 'localhost',
    port: port,
    path: '/api/chat',
    method: 'POST',
    headers: {'Content-Type': 'application/json'}
  };
  
  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('\nPOST /api/chat status:', res.statusCode);
      console.log('Response:', data.substring(0, 200));
      server.close();
    });
  });
  req.on('error', (e) => {
    console.log('Request error:', e.message);
    server.close();
  });
  req.write(JSON.stringify({message: 'test'}));
  req.end();
});
