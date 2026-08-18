(() => {
  'use strict';

  const templates = {
    cpp: `#include <iostream>\nusing namespace std;\n\nint main() {\n  long long a, b;\n  cin >> a >> b;\n  cout << a + b << '\\n';\n  return 0;\n}\n`,
    python: `a, b = map(int, input().split())\nprint(a + b)\n`
  };

  const source = document.querySelector('#source');
  const language = document.querySelector('#language');
  const submit = document.querySelector('#submit');
  const codeSize = document.querySelector('#code-size');
  const emptyRow = document.querySelector('#empty-row');
  const resultRow = document.querySelector('#result-row');
  const verdict = document.querySelector('#verdict');
  const time = document.querySelector('#time');
  const score = document.querySelector('#score');
  const resultLang = document.querySelector('#result-lang');

  function updateSize() {
    codeSize.textContent = new Blob([source.value]).size + ' B';
  }

  function loadTemplate() {
    source.value = templates[language.value];
    updateSize();
  }

  function simulatedVerdict(code, lang) {
    if (!code.trim()) return 'CE';
    if (lang === 'cpp') {
      const readsInput = /cin\s*>>\s*[a-zA-Z_]\w*\s*>>\s*[a-zA-Z_]\w*/.test(code);
      const printsSum = /cout\s*<<[^;]*(\+)[^;]*;/.test(code);
      return readsInput && printsSum ? 'AC' : 'WA';
    }
    const readsInput = /input\s*\(/.test(code);
    const printsSum = /print\s*\([^)]*\+[^)]*\)/.test(code);
    return readsInput && printsSum ? 'AC' : 'WA';
  }

  function showPending() {
    emptyRow.hidden = true;
    resultRow.hidden = false;
    verdict.className = 'pending';
    verdict.textContent = 'Judging';
    time.textContent = '—';
    score.textContent = '—';
    resultLang.textContent = language.options[language.selectedIndex].text;
  }

  submit.addEventListener('click', () => {
    showPending();
    submit.disabled = true;
    submit.textContent = '评测中…';
    document.querySelector('#status').scrollIntoView({ behavior: 'smooth', block: 'center' });

    window.setTimeout(() => {
      const result = simulatedVerdict(source.value, language.value);
      verdict.className = result.toLowerCase();
      verdict.textContent = result;
      time.textContent = result === 'CE' ? '—' : Math.floor(4 + Math.random() * 7) + ' ms';
      score.textContent = result === 'AC' ? '100' : '0';
      submit.disabled = false;
      submit.textContent = '再次提交';
    }, 850);
  });

  language.addEventListener('change', loadTemplate);
  source.addEventListener('input', updateSize);
  source.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const start = source.selectionStart;
    source.value = source.value.slice(0, start) + '  ' + source.value.slice(source.selectionEnd);
    source.selectionStart = source.selectionEnd = start + 2;
    updateSize();
  });

  loadTemplate();
})();
