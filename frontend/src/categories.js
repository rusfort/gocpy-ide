// Every highlightable element of Gocpy (and the editor UI) with its default color.
// kind: "fg" — text color, "bg" — background color.
export const GROUPS = [
  { id: 'ui', name: 'Интерфейс редактора' },
  { id: 'kw', name: 'Ключевые слова' },
  { id: 'unsafe', name: 'Unsafe и ручная память' },
  { id: 'types', name: 'Типы и дженерики' },
  { id: 'funcs', name: 'Функции и методы' },
  { id: 'pkg', name: 'Пакеты и импорты' },
  { id: 'ids', name: 'Идентификаторы' },
  { id: 'lit', name: 'Константы и числа' },
  { id: 'str', name: 'Строки и символы' },
  { id: 'cmt', name: 'Комментарии' },
  { id: 'annot', name: 'Аннотации и интринсики' },
  { id: 'op', name: 'Операторы и пунктуация' },
  { id: 'yaml', name: 'YAML (gocpy.yml, <file>.yml)' },
];

export const CATEGORIES = [
  // ---------- editor UI
  { id: 'ui-background', group: 'ui', kind: 'bg', name: 'Фон редактора', example: '', color: '#1e1e1e' },
  { id: 'ui-foreground', group: 'ui', kind: 'fg', name: 'Обычный текст', example: 'текст', color: '#d4d4d4' },
  { id: 'ui-gutter', group: 'ui', kind: 'fg', name: 'Номера строк', example: '42', color: '#6e7681' },
  { id: 'ui-gutter-active', group: 'ui', kind: 'fg', name: 'Номер текущей строки', example: '42', color: '#c6c6c6' },
  { id: 'ui-gutter-bg', group: 'ui', kind: 'bg', name: 'Фон колонки номеров', example: '', color: '#1e1e1e' },
  { id: 'ui-active-line', group: 'ui', kind: 'bg', name: 'Фон текущей строки', example: '', color: '#262a2e' },
  { id: 'ui-selection', group: 'ui', kind: 'bg', name: 'Выделение', example: '', color: '#264f78' },
  { id: 'ui-cursor', group: 'ui', kind: 'fg', name: 'Курсор', example: '|', color: '#aeafad' },
  { id: 'ui-bracket-match', group: 'ui', kind: 'bg', name: 'Парная скобка', example: '( )', color: '#3a4b45' },
  { id: 'ui-search-match', group: 'ui', kind: 'bg', name: 'Найденное совпадение', example: '', color: '#613214' },

  // ---------- keywords
  { id: 'kw-control', group: 'kw', kind: 'fg', name: 'Управление потоком', example: 'if else for switch case default break continue fallthrough return', color: '#c586c0' },
  { id: 'kw-decl', group: 'kw', kind: 'fg', name: 'Объявления', example: 'func type var const', color: '#569cd6' },
  { id: 'kw-typedef', group: 'kw', kind: 'fg', name: 'Составные типы', example: 'struct interface map chan', color: '#569cd6' },
  { id: 'kw-module', group: 'kw', kind: 'fg', name: 'Пакет и импорт', example: 'package import', color: '#c586c0' },
  { id: 'kw-in', group: 'kw', kind: 'fg', name: 'Итерация in', example: 'for x in xs', color: '#c586c0' },
  { id: 'kw-conc', group: 'kw', kind: 'fg', name: 'Конкурентность и отложенный вызов', example: 'go defer select', color: '#d7a0f0' },
  { id: 'kw-exception', group: 'kw', kind: 'fg', name: 'Исключения', example: 'try catch finally throw', color: '#ef8f6a' },

  // ---------- unsafe
  { id: 'kw-unsafe', group: 'unsafe', kind: 'fg', name: 'Ключевое слово unsafe', example: 'unsafe', color: '#ff6b6b' },
  { id: 'unsafe-block', group: 'unsafe', kind: 'bg', name: 'Фон unsafe-блока', example: '', color: '#2d1f22' },
  { id: 'unsafe-func', group: 'unsafe', kind: 'fg', name: 'Функции памяти (только в unsafe)', example: 'malloc calloc realloc free memcpy memset slice', color: '#ff8a80' },
  { id: 'unsafe-cast', group: 'unsafe', kind: 'fg', name: 'Приведение указателя в unsafe', example: '(*Tick)(p)  uintptr(p)', color: '#f5a97f' },

  // ---------- types
  { id: 'type-builtin', group: 'types', kind: 'fg', name: 'Встроенные типы', example: 'int int64 uint8 float64 string bool byte rune uintptr any', color: '#4ec9b0' },
  { id: 'type-error', group: 'types', kind: 'fg', name: 'Типы ошибок и исключений', example: 'error Exception', color: '#f0b46c' },
  { id: 'type-user', group: 'types', kind: 'fg', name: 'Пользовательские типы', example: 'User Tick Stack', color: '#7fd8be' },
  { id: 'type-std', group: 'types', kind: 'fg', name: 'Типы стандартной библиотеки', example: 'sync.WaitGroup time.Duration', color: '#56b6c2' },
  { id: 'type-param', group: 'types', kind: 'fg', name: 'Параметры типа дженериков', example: '[T, U any]', color: '#e5c07b' },
  { id: 'type-constraint', group: 'types', kind: 'fg', name: 'Ограничения дженериков', example: 'comparable  ~int', color: '#c792ea' },

  // ---------- functions
  { id: 'func-decl', group: 'funcs', kind: 'fg', name: 'Объявление функции / метода', example: 'func main()', color: '#dcdcaa' },
  { id: 'func-call', group: 'funcs', kind: 'fg', name: 'Вызов функции', example: 'decode(buf)', color: '#e8e0a8' },
  { id: 'func-method', group: 'funcs', kind: 'fg', name: 'Вызов метода', example: 'r.put(b)', color: '#d9c98c' },
  { id: 'func-builtin', group: 'funcs', kind: 'fg', name: 'Встроенные функции', example: 'len cap append make new sizeof close delete', color: '#b69cff' },
  { id: 'func-std', group: 'funcs', kind: 'fg', name: 'Функции стандартной библиотеки', example: 'fmt.Println errors.New time.Sleep', color: '#e2c08d' },
  { id: 'func-operator', group: 'funcs', kind: 'fg', name: 'Перегруженный оператор', example: 'func (a Money) +(b Money)', color: '#ff9ff3' },

  // ---------- packages
  { id: 'pkg-path', group: 'pkg', kind: 'fg', name: 'Путь импорта', example: '"std/fmt"', color: '#d7ba7d' },
  { id: 'pkg-name', group: 'pkg', kind: 'fg', name: 'Имя / псевдоним пакета', example: 'fmt. errors. sync.', color: '#8fbcbb' },
  { id: 'pkg-decl', group: 'pkg', kind: 'fg', name: 'Имя текущего пакета', example: 'package main', color: '#8fbcbb' },
  { id: 'pkg-member', group: 'pkg', kind: 'fg', name: 'Константы и переменные пакетов', example: 'time.Second', color: '#4fc1ff' },

  // ---------- identifiers
  { id: 'var', group: 'ids', kind: 'fg', name: 'Переменные и параметры', example: 'buf out total', color: '#9cdcfe' },
  { id: 'field', group: 'ids', kind: 'fg', name: 'Поля и свойства', example: 'u.Name r.size', color: '#9cdcfe' },
  { id: 'field-decl', group: 'ids', kind: 'fg', name: 'Объявление поля структуры', example: 'Seq uint64', color: '#a6d8f0' },
  { id: 'label', group: 'ids', kind: 'fg', name: 'Метки', example: 'outer: for … break outer', color: '#ffcb6b' },

  // ---------- literals
  { id: 'const-bool', group: 'lit', kind: 'fg', name: 'Логические константы', example: 'true false', color: '#569cd6' },
  { id: 'const-nil', group: 'lit', kind: 'fg', name: 'nil', example: 'nil', color: '#569cd6' },
  { id: 'const-user', group: 'lit', kind: 'fg', name: 'Объявленные константы', example: 'const MaxSize = 10', color: '#4fc1ff' },
  { id: 'num-int', group: 'lit', kind: 'fg', name: 'Целые числа', example: '42  1_000', color: '#b5cea8' },
  { id: 'num-float', group: 'lit', kind: 'fg', name: 'Дробные числа', example: '2.5  1e9', color: '#b5cea8' },
  { id: 'num-radix', group: 'lit', kind: 'fg', name: 'Шестнадцатеричные, двоичные, восьмеричные', example: '0xFF 0b1010 0o17', color: '#9fd4b0' },

  // ---------- strings
  { id: 'str', group: 'str', kind: 'fg', name: 'Строки', example: '"hello"', color: '#ce9178' },
  { id: 'str-raw', group: 'str', kind: 'fg', name: 'Сырые строки', example: '`raw\\n`', color: '#d69d85' },
  { id: 'str-f', group: 'str', kind: 'fg', name: 'f-строки', example: 'f"Hello, …"', color: '#e8a87c' },
  { id: 'str-interp', group: 'str', kind: 'fg', name: 'Скобки интерполяции в f-строке', example: '{ }', color: '#569cd6' },
  { id: 'str-fspec', group: 'str', kind: 'fg', name: 'Спецификатор формата в f-строке', example: ':02d  :.2f', color: '#b5cea8' },
  { id: 'str-escape', group: 'str', kind: 'fg', name: 'Escape-последовательности', example: '\\n \\t \\x41 {{', color: '#d7ba7d' },
  { id: 'char', group: 'str', kind: 'fg', name: 'Символьные литералы', example: "'a'  '\\n'", color: '#e0a070' },

  // ---------- comments
  { id: 'comment', group: 'cmt', kind: 'fg', name: 'Комментарии', example: '// комментарий', color: '#6a9955' },
  { id: 'comment-directive', group: 'cmt', kind: 'fg', name: 'Директивы компилятора', example: '//gocpy:ignore:unused', color: '#c586c0' },
  { id: 'comment-todo', group: 'cmt', kind: 'fg', name: 'Метки TODO / FIXME', example: 'TODO FIXME XXX', color: '#ffcc00' },

  // ---------- annotations
  { id: 'annot-throws', group: 'annot', kind: 'fg', name: 'Аннотация @throws', example: '@throws', color: '#ff7a7a' },
  { id: 'annot-overload', group: 'annot', kind: 'fg', name: 'Аннотация @overload', example: '@overload', color: '#ff9ff3' },
  { id: 'annot', group: 'annot', kind: 'fg', name: 'Прочие аннотации', example: '@packed @align @inline @extern @export @deprecated', color: '#ffb86c' },
  { id: 'intrinsic', group: 'annot', kind: 'fg', name: 'Интринсики', example: '@be_to_le(x) @le_to_be(x)', color: '#ff79c6' },
  { id: 'annot-unknown', group: 'annot', kind: 'fg', name: 'Неизвестная аннотация', example: '@foo', color: '#f44747' },

  // ---------- operators
  { id: 'op-arith', group: 'op', kind: 'fg', name: 'Арифметика и биты', example: '+ - * / % & | ^ << >> &^ ++ --', color: '#d4d4d4' },
  { id: 'op-assign', group: 'op', kind: 'fg', name: 'Присваивание', example: '= := += -= <<=', color: '#d4d4d4' },
  { id: 'op-logic', group: 'op', kind: 'fg', name: 'Сравнение и логика', example: '== != < <= > >= && || !', color: '#d4d4d4' },
  { id: 'op-ptr', group: 'op', kind: 'fg', name: 'Указатель и адрес', example: '*p  &x  *Ring', color: '#f78c6c' },
  { id: 'op-question', group: 'op', kind: 'fg', name: 'Проброс ошибки ?', example: 'readAll(f)?', color: '#ff9e3b' },
  { id: 'op-arrow', group: 'op', kind: 'fg', name: 'Оператор канала <-', example: 'ch <- v  <-ch', color: '#d7a0f0' },
  { id: 'punct-bracket', group: 'op', kind: 'fg', name: 'Скобки', example: '( ) [ ] { }', color: '#ffd866' },
  { id: 'punct', group: 'op', kind: 'fg', name: 'Пунктуация', example: ', ; : . ...', color: '#bbbbbb' },
  { id: 'invalid', group: 'op', kind: 'fg', name: 'Недопустимые символы', example: '$ #', color: '#f44747' },

  // ---------- YAML
  { id: 'yaml-key', group: 'yaml', kind: 'fg', name: 'Ключ', example: 'module:', color: '#9cdcfe' },
  { id: 'yaml-string', group: 'yaml', kind: 'fg', name: 'Строковое значение', example: 'example.com/app', color: '#ce9178' },
  { id: 'yaml-number', group: 'yaml', kind: 'fg', name: 'Число', example: '2', color: '#b5cea8' },
  { id: 'yaml-bool', group: 'yaml', kind: 'fg', name: 'true / false / null', example: 'true', color: '#569cd6' },
  { id: 'yaml-comment', group: 'yaml', kind: 'fg', name: 'Комментарий', example: '# comment', color: '#6a9955' },
  { id: 'yaml-punct', group: 'yaml', kind: 'fg', name: 'Разметка', example: '- : [ ]', color: '#bbbbbb' },
];

export const DEFAULT_COLORS = Object.fromEntries(CATEGORIES.map(c => [c.id, c.color]));

export function effectiveColors(user) {
  const out = { ...DEFAULT_COLORS };
  for (const [k, v] of Object.entries(user || {})) {
    if (k in out && /^#[0-9a-fA-F]{6}$/.test(v)) out[k] = v.toLowerCase();
  }
  return out;
}

export function applyColors(colors, root = document.documentElement) {
  for (const [k, v] of Object.entries(colors)) root.style.setProperty('--c-' + k, v);
}

// CSS rules .t-<id> { color: var(--c-<id>) } for every fg category.
export function categoryCSS() {
  return CATEGORIES.filter(c => c.kind === 'fg' && !c.id.startsWith('ui-'))
    .map(c => `.t-${c.id}{color:var(--c-${c.id})}`).join('\n');
}
