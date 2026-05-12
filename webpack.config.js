const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';
  return {
  entry: './src/index.js',
  output: {
    filename: 'bundle.[contenthash].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true
  },
  // The `alt1` npm package references optional Node/Electron-only modules
  // behind runtime checks. They never execute in the browser — tell webpack
  // to stop resolving them.
  resolve: {
    fallback: {
      sharp: false,
      canvas: false,
      'electron/common': false
    }
  },
  module: {
    rules: [
      { test: /\.css$/, use: ['style-loader', 'css-loader'] }
    ]
  },
  performance: { hints: false },
  plugins: [
    new HtmlWebpackPlugin({ template: './src/index.html', title: 'dghelper' }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'appconfig.json',
          to: '.',
          transform: isDev
            ? (content) => {
                const cfg = JSON.parse(content.toString());
                cfg.appName = `${cfg.appName} (dev)`;
                return JSON.stringify(cfg, null, 2);
              }
            : undefined
        },
        { from: 'install.html', to: '.' },
        { from: 'icon.png', to: '.', noErrorOnMissing: true },
        { from: '_headers', to: '.' }
      ]
    })
  ],
  devServer: {
    static: path.resolve(__dirname, 'dist'),
    port: 7290,
    host: 'localhost',
    open: false,
    hot: true,
    headers: { 'Access-Control-Allow-Origin': '*' }
  }
  };
};
