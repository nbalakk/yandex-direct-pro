/**
 * Тренажер для подготовки к сертификации Яндекс Директ / Яндекс Метрика.
 *
 * Данные лежат в data/direct.js и data/metrica.js (db_direct_base, db_metrica_base).
 * Прогресс автоматически сохраняется в localStorage и дополнительно выгружается
 * в JSON-файл по кнопке.
 */
(function () {
    'use strict';

    // ------------------------------------------------------------------ данные

    var QUIZZES = {
        direct: { data: typeof db_direct_base !== 'undefined' ? db_direct_base : [] },
        metrica: { data: typeof db_metrica_base !== 'undefined' ? db_metrica_base : [] }
    };

    var EXAM_PRESETS = {
        fast: { count: 20, minutes: 20, title: 'Быстрый' },
        full: { count: 60, minutes: 60, title: 'Полный' }
    };

    var PASS_RATE = 80;
    var STORAGE_PROGRESS = 'ydp:progress:v2';
    var STORAGE_SETTINGS = 'ydp:settings:v2';

    /**
     * v: 2 — ответ совпал в двух источниках, 1 — подтверждён одним,
     * 0 — вопрос из старой базы без подтверждения.
     */
    function isVerified(question) {
        return question.v !== 0;
    }

    /** Стабильный идентификатор вопроса: не зависит от порядка в базе. */
    function questionId(question) {
        var text = question.q + '|' + question.o.join('|');
        var hash = 5381;
        for (var i = 0; i < text.length; i++) {
            hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
        }
        return (hash >>> 0).toString(36);
    }

    Object.keys(QUIZZES).forEach(function (key) {
        var byId = {};
        QUIZZES[key].data.forEach(function (question) {
            question.id = questionId(question);
            byId[question.id] = question;
        });
        QUIZZES[key].byId = byId;
        QUIZZES[key].hasUnverified = QUIZZES[key].data.some(function (q) { return !isVerified(q); });
    });

    // ----------------------------------------------------------------- состояние

    var settings = { theme: 'dark', verifiedOnly: true };
    var progress = {};            // quizKey -> { answers, order, current, finished }
    var examState = null;         // отдельное прохождение экзамена, прогресс тренажера не трогает
    var quizKey = 'direct';
    var mode = 'training';        // training | exam_setup | exam_active | exam_finished | exam_review
    var examType = null;
    var examTimer = null;
    var examTimeLeft = 0;
    var searchQuery = '';
    var gridExpanded = false;     // на узком экране список вопросов свёрнут

    var MOBILE_WIDTH = 850;

    function isMobile() {
        return document.documentElement.clientWidth <= MOBILE_WIDTH;
    }

    function el(id) { return document.getElementById(id); }

    /**
     * subset = true для проходов по подмножеству вопросов (например «повторить
     * ошибки»): такой проход не достраивается до полного пула.
     */
    function emptyRun() {
        return { answers: {}, order: [], current: 0, finished: false, subset: false };
    }

    function isExamRun() {
        return mode === 'exam_active' || mode === 'exam_finished' || mode === 'exam_review';
    }

    /** Текущее прохождение: экзаменационное или тренажерное. */
    function run() {
        if (isExamRun()) {
            if (!examState) examState = emptyRun();
            return examState;
        }
        if (!progress[quizKey]) progress[quizKey] = emptyRun();
        return progress[quizKey];
    }

    function shuffle(list) {
        for (var i = list.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = list[i];
            list[i] = list[j];
            list[j] = tmp;
        }
        return list;
    }

    // ------------------------------------------------------------------- хранение

    function readJson(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (err) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
            /* приватный режим или переполненное хранилище — работаем без сохранения */
        }
    }

    function saveProgress() {
        if (mode === 'training') writeJson(STORAGE_PROGRESS, progress);
    }

    function saveSettings() { writeJson(STORAGE_SETTINGS, settings); }

    // --------------------------------------------------------------------- пул

    /** Вопросы выбранного теста с учётом фильтра «только сверенные». */
    function pool() {
        var all = QUIZZES[quizKey].data;
        if (settings.verifiedOnly && QUIZZES[quizKey].hasUnverified) {
            return all.filter(isVerified);
        }
        return all;
    }

    function questionById(id) { return QUIZZES[quizKey].byId[id]; }

    /** Список вопросов текущего прохождения (в сохранённом порядке). */
    function activeQuestions() {
        return run().order.map(questionById).filter(Boolean);
    }

    /** Собирает новый порядок вопросов. ids — ограничить этим набором. */
    function buildRun(count, ids) {
        var items = pool();
        if (ids) {
            var allowed = {};
            ids.forEach(function (id) { allowed[id] = true; });
            items = items.filter(function (q) { return allowed[q.id]; });
        }
        var order = shuffle(items.map(function (q) { return q.id; }));
        if (count) order = order.slice(0, Math.min(count, order.length));
        return order;
    }

    /** Синхронизирует сохранённый порядок с текущим пулом вопросов. */
    function syncTrainingRun() {
        var state = run();
        var inPool = {};
        pool().forEach(function (q) { inPool[q.id] = true; });
        state.order = state.order.filter(function (id) { return inPool[id]; });

        if (!state.subset) {
            var known = {};
            state.order.forEach(function (id) { known[id] = true; });
            var missing = pool().filter(function (q) { return !known[q.id]; })
                .map(function (q) { return q.id; });
            if (missing.length) state.order = state.order.concat(shuffle(missing));
        }

        if (!state.order.length) {
            state.order = buildRun();
            state.subset = false;
        }
        if (state.current >= state.order.length) state.current = 0;
    }

    function answerFor(id) {
        var answers = run().answers;
        if (!answers[id]) {
            answers[id] = { selected: [], checked: false, isCorrect: false, usedHint: false, order: null };
        }
        return answers[id];
    }

    function sameSet(a, b) {
        if (a.length !== b.length) return false;
        var sortedA = a.slice().sort(function (x, y) { return x - y; });
        var sortedB = b.slice().sort(function (x, y) { return x - y; });
        return sortedA.every(function (value, i) { return value === sortedB[i]; });
    }

    // ------------------------------------------------------------------- статистика

    function stats() {
        var questions = activeQuestions();
        var result = { total: questions.length, done: 0, correct: 0, incorrect: 0, hint: 0 };
        questions.forEach(function (question) {
            var answer = run().answers[question.id];
            if (!answer || !answer.checked) return;
            result.done++;
            if (answer.usedHint) result.hint++;
            else if (answer.isCorrect) result.correct++;
            else result.incorrect++;
        });
        return result;
    }

    function mistakeIds() {
        return activeQuestions().filter(function (question) {
            var answer = run().answers[question.id];
            return answer && answer.checked && (!answer.isCorrect || answer.usedHint);
        }).map(function (question) { return question.id; });
    }

    // ----------------------------------------------------------------- отрисовка

    function matchesSearch(question) {
        if (!searchQuery) return true;
        var haystack = (question.q + ' ' + question.o.join(' ')).toLowerCase();
        return haystack.indexOf(searchQuery) !== -1;
    }

    function renderGrid() {
        var grid = el('question-grid');
        var questions = activeQuestions();
        grid.innerHTML = '';
        questions.forEach(function (question, index) {
            var item = document.createElement('div');
            var classes = ['grid-item'];
            if (index === run().current) classes.push('active');
            if (!matchesSearch(question)) classes.push('filtered-out');

            var answer = run().answers[question.id];
            if (mode === 'training' || mode === 'exam_review') {
                if (answer && answer.checked) {
                    if (answer.usedHint) classes.push('answered-hint');
                    else if (answer.isCorrect) classes.push('answered-correct');
                    else if (mode === 'exam_review' && !answer.selected.length) classes.push('unanswered');
                    else classes.push('answered-incorrect');
                }
            } else if (mode === 'exam_active') {
                if (answer && answer.selected.length) classes.push('answered');
            }

            item.className = classes.join(' ');
            item.textContent = String(index + 1);
            item.title = question.q;
            item.onclick = function () {
                if (isMobile()) setGridExpanded(false);
                goTo(index, true);
            };
            grid.appendChild(item);
        });
        updateGridToggle(questions.length);
    }

    /** Кнопка «все вопросы» — на узком экране заменяет постоянно видимый список. */
    function updateGridToggle(total) {
        var toggle = el('btn-grid-toggle');
        toggle.textContent = gridExpanded
            ? '✕ Скрыть список вопросов'
            : '☰ Все вопросы (' + (run().current + 1) + ' / ' + total + ')';
        toggle.setAttribute('aria-expanded', gridExpanded ? 'true' : 'false');
        el('quiz-container').classList.toggle('grid-collapsed', !gridExpanded);
    }

    function setGridExpanded(value) {
        gridExpanded = value;
        updateGridToggle(activeQuestions().length);
    }

    /** На телефоне после перехода возвращаем экран к началу вопроса. */
    function scrollToQuestion() {
        if (!isMobile()) return;
        var anchor = el('question-title');
        if (!anchor) return;
        var top = anchor.getBoundingClientRect().top + window.pageYOffset - 12;
        window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
    }

    function renderStats() {
        var data = stats();
        var percent = data.total ? Math.round((data.done / data.total) * 100) : 0;
        el('progress-fill').style.width = percent + '%';
        el('stat-done').textContent = data.done;
        el('stat-total').textContent = data.total;
        el('stat-correct').textContent = data.correct;
        el('stat-incorrect').textContent = data.incorrect;
        el('stat-hint').textContent = data.hint;
        el('stats-bar').hidden = mode === 'exam_active';
    }

    /** Скриншот к вопросу: кликом открывается в полноэкранном просмотре. */
    function renderImage(question) {
        var box = el('question-image');
        box.innerHTML = '';
        if (!question.img) {
            box.hidden = true;
            return;
        }
        box.hidden = false;

        var image = document.createElement('img');
        image.src = question.img;
        image.alt = question.alt || 'Скриншот к вопросу';
        image.onclick = function () { openLightbox(image.src, image.alt); };

        var caption = document.createElement('figcaption');
        caption.textContent = 'Нажмите на скриншот, чтобы увеличить';

        box.appendChild(image);
        box.appendChild(caption);
    }

    function openLightbox(src, alt) {
        var overlay = el('lightbox');
        var image = el('lightbox-image');
        image.src = src;
        image.alt = alt;
        overlay.hidden = false;
        document.body.style.overflow = 'hidden';
        el('lightbox-close').focus();
    }

    function closeLightbox() {
        var overlay = el('lightbox');
        if (overlay.hidden) return;
        overlay.hidden = true;
        el('lightbox-image').src = '';
        document.body.style.overflow = '';
    }

    function renderOptions(question, answer, revealed) {
        var container = el('options-container');
        container.innerHTML = '';
        var isMultiple = question.c.length > 1;

        if (!answer.order || answer.order.length !== question.o.length) {
            answer.order = shuffle(question.o.map(function (_, i) { return i; }));
        }

        answer.order.forEach(function (originalIndex, position) {
            var label = document.createElement('label');
            var classes = ['option'];
            var input = document.createElement('input');
            input.type = isMultiple ? 'checkbox' : 'radio';
            input.name = 'option';
            input.value = String(originalIndex);

            var isSelected = answer.selected.indexOf(originalIndex) !== -1;
            if (isSelected) {
                input.checked = true;
                if (!revealed) classes.push('selected');
            }

            if (revealed) {
                classes.push('disabled');
                input.disabled = true;
                var isCorrectOption = question.c.indexOf(originalIndex) !== -1;
                if (isCorrectOption && isSelected) classes.push('correct-answer');
                else if (!isCorrectOption && isSelected) classes.push('wrong-answer');
                else if (isCorrectOption) classes.push('missed-correct');
            }

            input.onchange = function () {
                if (revealed) return;
                if (isMultiple) {
                    if (input.checked) answer.selected.push(originalIndex);
                    else answer.selected = answer.selected.filter(function (v) { return v !== originalIndex; });
                } else {
                    answer.selected = [originalIndex];
                }
                saveProgress();
                renderQuestion();
            };

            label.className = classes.join(' ');
            label.appendChild(input);
            label.appendChild(document.createTextNode((position + 1) + '. ' + question.o[originalIndex]));
            container.appendChild(label);
        });
    }

    function renderQuestion() {
        var questions = activeQuestions();
        if (!questions.length) {
            el('quiz-container').hidden = true;
            renderStats();
            return;
        }
        if (run().current >= questions.length) run().current = questions.length - 1;

        var question = questions[run().current];
        var answer = answerFor(question.id);
        var revealed = (mode === 'training' || mode === 'exam_review') && answer.checked;
        var isMultiple = question.c.length > 1;

        var title = 'Вопрос ' + (run().current + 1) + ' из ' + questions.length +
            (isMultiple ? ' (несколько вариантов)' : ' (один вариант)');
        el('question-title').textContent = title;

        var textEl = el('question-text');
        textEl.textContent = question.q;
        if (!isVerified(question)) {
            var badge = document.createElement('span');
            badge.className = 'badge-unverified';
            badge.textContent = 'без источника';
            badge.title = 'Вопрос из старой базы: ответ не подтверждён ни одним источником';
            textEl.appendChild(badge);
        }

        var statusEl = el('question-status');
        statusEl.textContent = '';
        statusEl.className = 'question-status';
        if (revealed) {
            if (answer.usedHint) {
                statusEl.textContent = '💡 Использована подсказка';
                statusEl.className = 'question-status status-hint';
            } else if (mode === 'exam_review' && !answer.selected.length) {
                statusEl.textContent = '❌ Нет ответа';
                statusEl.className = 'question-status status-unanswered';
            } else {
                statusEl.textContent = answer.isCorrect ? '✅ Верно' : '❌ Ошибка';
                statusEl.className = 'question-status ' +
                    (answer.isCorrect ? 'status-correct' : 'status-incorrect');
            }
        }

        renderImage(question);
        renderOptions(question, answer, revealed);

        var noteBox = el('note-box');
        noteBox.innerHTML = '';
        if (revealed && question.note) {
            var noteTitle = document.createElement('span');
            noteTitle.className = 'note-title';
            noteTitle.textContent = 'Разбор';
            noteBox.appendChild(noteTitle);
            noteBox.appendChild(document.createTextNode(question.note));
            noteBox.hidden = false;
        } else {
            noteBox.hidden = true;
        }

        var help = el('help-placeholder');
        help.innerHTML = '';
        if (mode !== 'exam_active') {
            var link = document.createElement('a');
            link.className = 'btn-ref';
            link.setAttribute('aria-label', 'Справка');
            link.appendChild(document.createTextNode('📚'));
            var linkLabel = document.createElement('span');
            linkLabel.className = 'btn-label';
            linkLabel.textContent = ' Справка';
            link.appendChild(linkLabel);
            if (question.ref) {
                link.href = question.ref;
                link.target = '_blank';
                link.rel = 'noopener';
            } else {
                link.href = 'javascript:void(0)';
                link.onclick = function () {
                    alert('Упс... Не нашли информацию, но можете найти и написать в tg: @nbalakk :)');
                };
            }
            help.appendChild(link);
        }

        renderGrid();
        renderStats();
        updateButtons(answer, revealed, questions.length);
    }

    function updateButtons(answer, revealed, total) {
        el('btn-prev').style.visibility = run().current === 0 ? 'hidden' : 'visible';

        var hint = el('btn-hint');
        hint.hidden = !(mode === 'training' && !revealed);

        var action = el('btn-action');
        action.style.background = '';
        action.style.color = '';
        action.className = 'btn-primary';
        action.disabled = false;
        var isLast = run().current === total - 1;

        if (mode === 'training') {
            if (!revealed) {
                action.textContent = 'Проверить ответ';
                action.className = 'btn-primary btn-check';
                action.disabled = !answer.selected.length;
            } else {
                action.textContent = isLast ? 'Завершить тест' : 'Далее ➔';
            }
        } else if (mode === 'exam_active') {
            if (isLast) {
                var unanswered = activeQuestions().some(function (question) {
                    var current = run().answers[question.id];
                    return !current || !current.selected.length;
                });
                action.textContent = unanswered ? 'Завершить (есть пропуски)' : 'Завершить экзамен';
                if (unanswered) {
                    action.style.background = 'var(--error-border)';
                    action.style.color = '#fff';
                }
            } else {
                action.textContent = 'Далее ➔';
            }
        } else if (mode === 'exam_review') {
            action.textContent = isLast ? 'К результатам' : 'Далее ➔';
        }
    }

    // --------------------------------------------------------------- переключение

    /**
     * Предупреждение при уходе со страницы вешаем только на время экзамена:
     * в тренажере прогресс и так сохраняется сам.
     */
    function onBeforeUnload(event) {
        var message = 'Активный экзамен будет прерван, результаты не сохранятся.';
        event.returnValue = message;
        return message;
    }

    function setExamGuard(active) {
        if (active) window.addEventListener('beforeunload', onBeforeUnload);
        else window.removeEventListener('beforeunload', onBeforeUnload);
    }

    function setMode(next) {
        if (mode === 'exam_active' && next !== 'exam_active' && next !== 'exam_finished') {
            if (!confirm('У вас активен экзамен. При переключении режима он будет прерван и результаты не сохранятся. Продолжить?')) {
                return;
            }
            clearInterval(examTimer);
        }

        closeLightbox();
        mode = next;
        setExamGuard(mode === 'exam_active');
        var isLight = document.body.classList.contains('theme-light');
        document.body.className = isLight ? 'theme-light' : '';

        el('btn-mode-training').classList.remove('active');
        el('btn-mode-exam').classList.remove('active');
        el('quiz-container').hidden = true;
        el('results-container').hidden = true;
        el('exam-setup').hidden = true;
        el('exam-info-bar').hidden = true;
        el('header-controls').hidden = false;
        el('mode-selector').hidden = false;
        el('training-toolbar').hidden = true;
        el('stats-bar').hidden = true;
        el('quiz-selector').disabled = false;
        el('question-search').hidden = false;
        el('btn-restart').hidden = false;

        if (mode === 'training') {
            document.body.classList.add('mode-training');
            el('btn-mode-training').classList.add('active');
            el('main-title').textContent = 'Тренажер';
            el('training-toolbar').hidden = false;
            syncTrainingRun();
            if (run().finished) {
                showResults();
            } else {
                el('quiz-container').hidden = false;
                renderQuestion();
            }
        } else if (mode === 'exam_setup') {
            el('btn-mode-exam').classList.add('active');
            el('main-title').textContent = 'Экзамен';
            el('exam-setup').hidden = false;
            el('header-controls').hidden = true;
            // из фильтров в экзамене осмысленен только выбор пула вопросов
            el('training-toolbar').hidden = false;
            el('question-search').hidden = true;
            el('btn-restart').hidden = true;
            updateExamCounts();
            examType = null;
            document.querySelectorAll('.exam-card').forEach(function (card) {
                card.classList.remove('selected');
            });
            el('btn-start-exam').disabled = true;
        } else if (mode === 'exam_active') {
            document.body.classList.add('mode-exam');
            el('main-title').textContent = 'Экзамен';
            el('quiz-selector').disabled = true;
            el('mode-selector').hidden = true;
            el('header-controls').hidden = true;
            el('exam-info-bar').hidden = false;
            el('quiz-container').hidden = false;
            renderQuestion();
        } else if (mode === 'exam_review') {
            document.body.classList.add('mode-review');
            el('main-title').textContent = 'Просмотр ошибок';
            el('quiz-selector').disabled = true;
            el('btn-mode-exam').classList.add('active');
            el('header-controls').hidden = true;
            el('quiz-container').hidden = false;
            run().current = 0;
            renderQuestion();
        }
    }

    function updateExamCounts() {
        var total = pool().length;
        el('fast-q-count').textContent = Math.min(EXAM_PRESETS.fast.count, total);
        el('full-q-count').textContent = Math.min(EXAM_PRESETS.full.count, total);
    }

    function goTo(index, scroll) {
        run().current = index;
        renderQuestion();
        saveProgress();
        if (scroll !== false) scrollToQuestion();
    }

    // ------------------------------------------------------------------- экзамен

    function startExam() {
        if (!examType) return;
        var preset = EXAM_PRESETS[examType];
        var order = buildRun(preset.count);
        if (!order.length) {
            alert('В выбранном тесте нет вопросов.');
            return;
        }

        examState = { answers: {}, order: order, current: 0, finished: false, subset: true };
        el('exam-info-text').textContent = 'Экзамен: ' + preset.title + ' (' + order.length + ' вопр.)';

        examTimeLeft = preset.minutes * 60;
        updateTimer();
        clearInterval(examTimer);
        examTimer = setInterval(function () {
            examTimeLeft--;
            updateTimer();
            if (examTimeLeft <= 0) {
                clearInterval(examTimer);
                alert('Время вышло! Экзамен завершен.');
                finishExam();
            }
        }, 1000);

        setMode('exam_active');
    }

    function updateTimer() {
        var timer = el('exam-timer');
        var minutes = String(Math.floor(examTimeLeft / 60)).padStart(2, '0');
        var seconds = String(examTimeLeft % 60).padStart(2, '0');
        timer.textContent = '⏱ ' + minutes + ':' + seconds;
        timer.classList.toggle('warning', examTimeLeft <= 60);
    }

    function finishExam() {
        activeQuestions().forEach(function (question) {
            var answer = answerFor(question.id);
            answer.isCorrect = sameSet(question.c, answer.selected);
            answer.checked = true;
        });
        mode = 'exam_finished';
        setExamGuard(false);
        run().finished = true;
        showResults();
    }

    // ------------------------------------------------------------------ действия

    function checkAnswer() {
        var question = activeQuestions()[run().current];
        var answer = answerFor(question.id);
        answer.isCorrect = sameSet(question.c, answer.selected);
        answer.checked = true;
        saveProgress();
        renderQuestion();
    }

    function useHint() {
        if (mode !== 'training') return;
        var question = activeQuestions()[run().current];
        var answer = answerFor(question.id);
        if (answer.checked) return;
        answer.selected = question.c.slice();
        answer.checked = true;
        answer.isCorrect = false;
        answer.usedHint = true;
        saveProgress();
        renderQuestion();
    }

    function handleAction() {
        var questions = activeQuestions();
        var isLast = run().current === questions.length - 1;

        if (mode === 'training') {
            var answer = answerFor(questions[run().current].id);
            if (!answer.checked) {
                checkAnswer();
            } else if (isLast) {
                run().finished = true;
                saveProgress();
                showResults();
            } else {
                goTo(run().current + 1);
            }
        } else if (mode === 'exam_active') {
            if (!isLast) {
                goTo(run().current + 1);
                return;
            }
            var unanswered = questions.some(function (question) {
                var current = run().answers[question.id];
                return !current || !current.selected.length;
            });
            if (unanswered && !confirm('Вы ответили не на все вопросы. Неотвеченные будут засчитаны как ошибки. Завершить?')) {
                return;
            }
            clearInterval(examTimer);
            finishExam();
        } else if (mode === 'exam_review') {
            if (isLast) {
                el('quiz-container').hidden = true;
                el('results-container').hidden = false;
            } else {
                goTo(run().current + 1);
            }
        }
    }

    // ----------------------------------------------------------------- результаты

    function mistakeListNode() {
        var ids = mistakeIds();
        if (!ids.length) return null;

        var box = document.createElement('div');
        box.className = 'mistakes';
        var heading = document.createElement('h3');
        heading.textContent = 'Разбор ошибок — ' + ids.length;
        box.appendChild(heading);

        ids.forEach(function (id) {
            var question = questionById(id);
            var answer = run().answers[id];
            var item = document.createElement('div');
            item.className = 'mistake-item';

            var text = document.createElement('div');
            text.className = 'mistake-q';
            text.textContent = question.q;
            item.appendChild(text);

            var list = document.createElement('ul');
            question.c.forEach(function (index) {
                var li = document.createElement('li');
                li.className = 'right';
                li.textContent = 'Верно: ' + question.o[index];
                list.appendChild(li);
            });
            answer.selected.filter(function (index) {
                return question.c.indexOf(index) === -1;
            }).forEach(function (index) {
                var li = document.createElement('li');
                li.className = 'wrong';
                li.textContent = 'Ваш ответ: ' + question.o[index];
                list.appendChild(li);
            });
            if (answer.usedHint) {
                var li = document.createElement('li');
                li.textContent = 'Была использована подсказка';
                list.appendChild(li);
            }
            item.appendChild(list);
            box.appendChild(item);
        });
        return box;
    }

    function showResults() {
        var container = el('results-container');
        el('quiz-container').hidden = true;
        el('exam-info-bar').hidden = true;
        el('training-toolbar').hidden = true;
        el('stats-bar').hidden = true;
        container.hidden = false;
        container.innerHTML = '';

        var data = stats();
        var isExam = mode === 'exam_finished';
        var percent = data.total ? Math.round((data.correct / data.total) * 100) : 0;

        var box = document.createElement('div');
        box.className = 'result-stats';

        var heading = document.createElement('h2');
        heading.textContent = isExam ? 'Экзамен завершен!' : 'Тест завершен!';
        box.appendChild(heading);

        if (isExam) {
            var verdict = document.createElement('div');
            verdict.style.cssText = 'font-size:1.5em;font-weight:bold;margin-bottom:15px;';
            var passed = percent >= PASS_RATE;
            verdict.appendChild(document.createTextNode('Результат: '));
            var mark = document.createElement('span');
            mark.style.color = passed ? 'var(--correct-border)' : 'var(--error-border)';
            mark.textContent = passed ? 'СДАН' : 'НЕ СДАН';
            verdict.appendChild(mark);
            verdict.appendChild(document.createTextNode(' (проходной ' + PASS_RATE + '%)'));
            box.appendChild(verdict);
        }

        var answered = document.createElement('span');
        answered.style.cssText = 'font-size:0.8em;color:var(--text-muted);';
        answered.textContent = 'Отвечено на ' + data.done + ' из ' + data.total + ' вопросов';
        box.appendChild(answered);

        var score = document.createElement('div');
        score.className = 'result-score';
        score.textContent = String(data.correct);
        box.appendChild(score);

        var scoreLabel = document.createElement('span');
        scoreLabel.style.cssText = 'color:var(--text-muted);font-size:1.2em;';
        scoreLabel.textContent = 'Правильных ответов (' + percent + '%)';
        box.appendChild(scoreLabel);

        if (!isExam && data.hint) {
            var hints = document.createElement('span');
            hints.style.cssText = 'color:var(--hint-color);font-size:0.9em;display:block;margin-top:20px;';
            hints.textContent = 'Использовано подсказок: ' + data.hint;
            box.appendChild(hints);
        }
        container.appendChild(box);

        var mistakes = mistakeListNode();
        if (mistakes) container.appendChild(mistakes);

        var actions = document.createElement('div');
        actions.className = 'result-actions';
        if (isExam) {
            actions.appendChild(button('btn-secondary', 'Посмотреть ошибки', function () {
                setMode('exam_review');
            }));
            actions.appendChild(button('btn-primary', 'Новый экзамен', function () {
                setMode('exam_setup');
            }));
        } else {
            if (mistakeIds().length) {
                actions.appendChild(button('btn-secondary', 'Повторить ошибки', retryMistakes));
            }
            actions.appendChild(button('btn-primary', 'Начать заново', restart));
        }
        container.appendChild(actions);
    }

    function button(className, text, onClick) {
        var node = document.createElement('button');
        node.type = 'button';
        node.className = className;
        node.textContent = text;
        node.onclick = onClick;
        return node;
    }

    function retryMistakes() {
        var ids = mistakeIds();
        if (!ids.length) return;
        progress[quizKey] = { answers: {}, order: shuffle(ids), current: 0,
            finished: false, subset: true };
        saveProgress();
        setMode('training');
    }

    function restart() {
        if (mode === 'training' && stats().done &&
            !confirm('Прогресс текущего тренажера будет сброшен. Уверены?')) {
            return;
        }
        progress[quizKey] = { answers: {}, order: buildRun(), current: 0,
            finished: false, subset: false };
        saveProgress();
        setMode('training');
    }

    // -------------------------------------------------------------- экспорт/импорт

    function exportProgress() {
        saveProgress();
        var payload = JSON.stringify({ version: 2, progress: progress }, null, 1);
        var url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
        var link = document.createElement('a');
        link.href = url;
        link.download = 'yandex_certification_progress.json';
        link.click();
        URL.revokeObjectURL(url);
    }

    /** Старые файлы хранили ответы по индексам, но рядом лежали тексты вопросов. */
    function migrateLegacySave(data) {
        var migrated = {};
        Object.keys(QUIZZES).forEach(function (key) {
            var legacy = data[key];
            if (!legacy || !legacy.questions) return;
            var state = emptyRun();
            legacy.questions.forEach(function (question) {
                if (!question || !question.q || !question.o) return;
                var id = questionId(question);
                if (!QUIZZES[key].byId[id]) return;
                state.order.push(id);
                var old = (legacy.userAnswers || {})[question.id];
                if (old) {
                    state.answers[id] = {
                        selected: old.selected || [],
                        checked: !!old.checked,
                        isCorrect: !!old.isCorrect,
                        usedHint: !!old.usedHint,
                        order: null
                    };
                }
            });
            state.finished = !!legacy.isFinished;
            migrated[key] = state;
        });
        return migrated;
    }

    function importProgress(event) {
        var file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        if (mode === 'exam_active') {
            if (!confirm('У вас активен экзамен. Загрузка файла прервет его. Продолжить?')) return;
            clearInterval(examTimer);
        }

        var reader = new FileReader();
        reader.onload = function (e) {
            var loaded;
            try {
                loaded = JSON.parse(e.target.result);
            } catch (err) {
                alert('Ошибка при чтении файла сохранения.');
                return;
            }

            var next = null;
            if (loaded && loaded.version === 2 && loaded.progress) {
                next = loaded.progress;
            } else if (loaded && (loaded.direct || loaded.metrica)) {
                next = migrateLegacySave(loaded);
            }

            if (!next || !Object.keys(next).length) {
                alert('Не удалось распознать файл прогресса.');
                return;
            }

            progress = {};
            Object.keys(QUIZZES).forEach(function (key) {
                progress[key] = next[key] && next[key].order ? next[key] : emptyRun();
            });
            saveProgress();
            setMode('training');
            alert('Прогресс успешно загружен!');
        };
        reader.readAsText(file);
    }

    // ------------------------------------------------------------------- события

    function applyTheme() {
        var light = settings.theme === 'light';
        el('theme-toggle').checked = light;
        document.body.classList.toggle('theme-light', light);
    }

    function onKeyDown(event) {
        if (!el('lightbox').hidden) {
            if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
                closeLightbox();
                event.preventDefault();
            }
            return;
        }
        var tag = (event.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (el('quiz-container').hidden) return;

        if (event.key >= '1' && event.key <= '9') {
            var index = Number(event.key) - 1;
            var inputs = el('options-container').querySelectorAll('input');
            if (inputs[index] && !inputs[index].disabled) {
                inputs[index].checked = inputs[index].type === 'checkbox' ? !inputs[index].checked : true;
                inputs[index].dispatchEvent(new Event('change'));
                event.preventDefault();
            }
        } else if (event.key === 'Enter') {
            if (!el('btn-action').disabled) el('btn-action').click();
            event.preventDefault();
        } else if (event.key === 'ArrowLeft') {
            if (run().current > 0) goTo(run().current - 1);
        } else if (event.key === 'ArrowRight') {
            if (run().current < activeQuestions().length - 1) goTo(run().current + 1);
        } else if (event.key === 'h' || event.key === 'H' || event.key === 'р' || event.key === 'Р') {
            useHint();
        }
    }

    /**
     * Свайп влево/вправо переключает вопрос. Жест считается горизонтальным,
     * только если сдвиг по X заметно больше вертикального — иначе это обычная
     * прокрутка страницы.
     */
    function bindSwipe() {
        var startX = 0;
        var startY = 0;
        var tracking = false;
        var container = el('quiz-container');

        container.addEventListener('touchstart', function (event) {
            if (event.touches.length !== 1 || !el('lightbox').hidden) {
                tracking = false;
                return;
            }
            if (event.target.closest('#question-image, #question-grid, input, a, button')) {
                tracking = false;
                return;
            }
            tracking = true;
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
        }, { passive: true });

        container.addEventListener('touchend', function (event) {
            if (!tracking || !event.changedTouches.length) return;
            tracking = false;
            var dx = event.changedTouches[0].clientX - startX;
            var dy = event.changedTouches[0].clientY - startY;
            if (Math.abs(dx) < 70 || Math.abs(dy) > 45 || Math.abs(dx) < Math.abs(dy) * 2) {
                return;
            }
            var last = activeQuestions().length - 1;
            if (dx < 0 && run().current < last) goTo(run().current + 1);
            if (dx > 0 && run().current > 0) goTo(run().current - 1);
        }, { passive: true });
    }

    function bind() {
        el('theme-toggle').onchange = function () {
            settings.theme = this.checked ? 'light' : 'dark';
            applyTheme();
            saveSettings();
        };

        el('btn-menu').onclick = function (event) {
            event.stopPropagation();
            el('linksDropdown').classList.toggle('show');
        };
        document.addEventListener('click', function (event) {
            if (!event.target.closest('#btn-menu')) {
                el('linksDropdown').classList.remove('show');
            }
        });

        el('quiz-selector').onchange = function () {
            quizKey = this.value;
            searchQuery = '';
            el('question-search').value = '';
            updateVerifiedFilterVisibility();
            setMode(mode === 'exam_setup' ? 'exam_setup' : 'training');
        };

        el('btn-mode-training').onclick = function () { setMode('training'); };
        el('btn-mode-exam').onclick = function () { setMode('exam_setup'); };
        el('btn-force-finish').onclick = function () {
            if (confirm('Вы уверены, что хотите завершить экзамен досрочно? Неотвеченные вопросы будут засчитаны как ошибки.')) {
                clearInterval(examTimer);
                finishExam();
            }
        };

        document.querySelectorAll('.exam-card').forEach(function (card) {
            card.onclick = function () {
                examType = card.getAttribute('data-exam');
                document.querySelectorAll('.exam-card').forEach(function (other) {
                    other.classList.remove('selected');
                });
                card.classList.add('selected');
                el('btn-start-exam').disabled = false;
            };
        });
        el('btn-start-exam').onclick = startExam;

        el('btn-prev').onclick = function () {
            if (run().current > 0) goTo(run().current - 1);
        };
        el('btn-hint').onclick = useHint;
        el('btn-action').onclick = handleAction;
        el('btn-restart').onclick = restart;

        el('btn-export').onclick = exportProgress;
        el('btn-import').onclick = function () { el('fileInput').click(); };
        el('fileInput').onchange = importProgress;

        el('question-search').oninput = function () {
            searchQuery = this.value.trim().toLowerCase();
            renderGrid();
        };
        el('question-search').onkeydown = function (event) {
            if (event.key !== 'Enter') return;
            var index = activeQuestions().findIndex(matchesSearch);
            if (index !== -1) goTo(index);
        };

        el('verified-only').onchange = function () {
            settings.verifiedOnly = this.checked;
            saveSettings();
            if (mode === 'training') setMode('training');
            else if (mode === 'exam_setup') updateExamCounts();
        };

        el('btn-grid-toggle').onclick = function () {
            setGridExpanded(!gridExpanded);
            if (gridExpanded) {
                el('question-grid').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        };

        bindSwipe();

        el('lightbox').onclick = closeLightbox;
        el('lightbox-close').onclick = closeLightbox;
        el('lightbox-image').onclick = function (event) { event.stopPropagation(); };

        document.addEventListener('keydown', onKeyDown);

    }

    function updateVerifiedFilterVisibility() {
        el('verified-filter-wrap').hidden = !QUIZZES[quizKey].hasUnverified;
    }

    function init() {
        settings = Object.assign(settings, readJson(STORAGE_SETTINGS, {}));
        progress = readJson(STORAGE_PROGRESS, {}) || {};
        Object.keys(QUIZZES).forEach(function (key) {
            var state = progress[key];
            if (!state || !Array.isArray(state.order) || typeof state.answers !== 'object') {
                progress[key] = emptyRun();
            }
        });

        el('verified-only').checked = settings.verifiedOnly;
        applyTheme();
        updateVerifiedFilterVisibility();
        bind();
        setMode('training');
    }

    document.addEventListener('DOMContentLoaded', init);
})();
