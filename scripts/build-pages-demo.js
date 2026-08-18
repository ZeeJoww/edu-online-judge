#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'public');
const target = path.join(root, 'docs', 'oj');
const mockSource = path.join(root, 'demo', 'mock-api.js');

const pages = [
  'index.html', 'problems.html', 'problem.html', 'homework.html', 'status.html',
  'wrong.html', 'rank.html', 'contest.html', 'exam.html', 'clar.html', 'files.html',
  'view.html', 'about.html', 'me.html'
];
const assets = ['style.css', 'gate.js', 'common.js'];

function copyTree(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function rewriteRootPaths(text) {
  return text
    .replace(/(["'`])\/(?!\/)([^"'`\r\n]*)\1/g, (_all, quote, value) => {
      return quote + (value || 'index.html') + quote;
    })
    .replace(/(href|src)=(["'])\//g, '$1=$2');
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

for (const name of assets) {
  const content = fs.readFileSync(path.join(source, name), 'utf8');
  fs.writeFileSync(path.join(target, name), rewriteRootPaths(content));
}

for (const name of pages) {
  let content = fs.readFileSync(path.join(source, name), 'utf8');
  content = rewriteRootPaths(content);
  content = content.replace(/\s*<a href="admin\.html">管理<\/a>/g, '');
  const mockTag = '<script src="demo-mock.js"></script>';
  content = content.replace('</head>', mockTag + '\n</head>');
  fs.writeFileSync(path.join(target, name), content);
}

copyTree(path.join(source, 'vendor'), path.join(target, 'vendor'));
copyTree(mockSource, path.join(target, 'demo-mock.js'));

console.log(`Built ${pages.length} student pages in ${target}`);
