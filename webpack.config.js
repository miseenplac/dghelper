const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'bundle.[contenthash].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true
  },
  // The `alt1` npm package references optional Node/Electron-only modules
  // (sharp, canvas, electron/common) behind runtime checks. They never
  // execute in the browser; tell webpack to stop resolving them.
  resolve: {
    fallback: {
      sharp: false,
      canvas: false,
      'electron/common': false
    }
  },
  module: {
    rules: [
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
      { test: /\.(png|jpg|gif|svg)$/, type: 'asset/resource' }
    ]
  },
  performance: { hints: false },
  plugins: [
    new HtmlWebpackPlugin({ template: './src/index.html', title: 'DungKey Tracker' }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'appconfig.json', to: '.' },
        { from: 'install.html', to: '.' },
        { from: 'icon.png', to: '.', noErrorOnMissing: true }
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
