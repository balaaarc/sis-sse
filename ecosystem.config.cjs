module.exports = {
  apps: [
    {
      name: 'iinvsys-sse',
      script: 'src/index.js',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      },
      error_file: 'logs/sse-error.log',
      out_file: 'logs/sse-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
