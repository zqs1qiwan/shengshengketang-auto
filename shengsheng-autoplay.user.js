// ==UserScript==
// @name         声声课堂自动挂课助手
// @namespace    https://github.com/zqs1qiwan/shengshengketang-auto
// @version      1.2.0
// @description  声声课堂(shengshengketang.com)自动挂课工具 — 自动播放(最高7.5x)、自动答题、自动切换下一节/下一门课
// @author       zqs1qiwan
// @license      MIT
// @match        https://www.shengshengketang.com/*
// @icon         https://www.shengshengketang.com/favicon.ico
// @homepage     https://github.com/zqs1qiwan/shengshengketang-auto
// @supportURL   https://github.com/zqs1qiwan/shengshengketang-auto/issues
// @updateURL    https://raw.githubusercontent.com/zqs1qiwan/shengshengketang-auto/main/shengsheng-autoplay.user.js
// @downloadURL  https://raw.githubusercontent.com/zqs1qiwan/shengshengketang-auto/main/shengsheng-autoplay.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ============ 配置 ============
  const CONFIG = {
    playbackRate: 3, // 默认播放速度
    speedOptions: [1, 1.5, 3, 4, 5, 6, 7, 7.5], // 可选倍速
    autoAnswer: true, // 自动答题
    autoNext: true, // 自动切下一节
    autoMute: true, // 自动静音
    progressInterval: 3000, // 检查间隔(ms)
    answerDelay: 2000, // 答题前等待(ms) 模拟真人
    nextVideoDelay: 3000, // 切换下一节等待(ms)
  };

  // ============ 状态 ============
  const STATE = {
    running: false,
    quizAnswerMap: {}, // popQuizId -> correctAnswer
    totalCompleted: 0,
    currentNode: "",
    log: [],
    switchingVideo: false, // 防重入: 正在切换视频
    handlingQuiz: false, // 防重入: 正在处理答题
    lastEndedVideoSrc: null, // 防重入: 上一个结束的视频 src
  };

  // ============ 日志 ============
  function log(msg, type = "info") {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    STATE.log.push(entry);
    if (STATE.log.length > 100) STATE.log.shift();

    const style =
      type === "error"
        ? "color:red"
        : type === "success"
          ? "color:green"
          : type === "warn"
            ? "color:orange"
            : "color:#4fc3f7";
    console.log(`%c[挂课助手] ${entry}`, style);
    updatePanel();
  }

  // ============ API 拦截 - 抓取题目答案 ============
  function interceptXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._autoUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          if (
            this._autoUrl &&
            this._autoUrl.includes("popQuiz/getByCourseAndNodeId")
          ) {
            const data = JSON.parse(this.responseText);
            if (data.code === 200 && data.data) {
              data.data.forEach((quiz) => {
                if (quiz.question && quiz.question.answer) {
                  STATE.quizAnswerMap[quiz.id] = {
                    answer: quiz.question.answer,
                    questionId: quiz.question.id,
                    type: quiz.question.type,
                    name: quiz.question.name,
                    isMustRight: quiz.isMustRight,
                    isSkip: quiz.isSkip,
                  };
                  log(
                    `缓存题目答案: "${quiz.question.name.substring(0, 20)}..." -> ${quiz.question.answer}`,
                  );
                }
              });
            }
          }

          // 监听进度上传结果
          if (
            this._autoUrl &&
            this._autoUrl.includes("addCourseViewingRecords")
          ) {
            const data = JSON.parse(this.responseText);
            if (data.code === 200) {
              log("进度上传成功", "success");
            } else {
              log(`进度上传失败: ${data.msg}`, "error");
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      });
      return origSend.apply(this, args);
    };

    // Also intercept fetch
    const origFetch = window.fetch;
    window.fetch = function (url, options) {
      return origFetch.apply(this, arguments).then((response) => {
        const cloned = response.clone();
        if (typeof url === "string") {
          if (url.includes("popQuiz/getByCourseAndNodeId")) {
            cloned.json().then((data) => {
              if (data.code === 200 && data.data) {
                data.data.forEach((quiz) => {
                  if (quiz.question && quiz.question.answer) {
                    STATE.quizAnswerMap[quiz.id] = {
                      answer: quiz.question.answer,
                      questionId: quiz.question.id,
                      type: quiz.question.type,
                      name: quiz.question.name,
                      isMustRight: quiz.isMustRight,
                      isSkip: quiz.isSkip,
                    };
                  }
                });
              }
            });
          }
        }
        return response;
      });
    };

    log("API 拦截已启动");
  }

  // ============ 获取视频元素 ============
  function getVideo() {
    return document.querySelector("video");
  }

  // ============ 设置播放速度 ============
  function setPlaybackRate() {
    const video = getVideo();
    if (video && video.playbackRate !== CONFIG.playbackRate) {
      video.playbackRate = CONFIG.playbackRate;
      log(`播放速度设置为 ${CONFIG.playbackRate}x`);
    }
  }

  // ============ 静音 ============
  function muteVideo() {
    if (!CONFIG.autoMute) return;
    const video = getVideo();
    if (video && !video.muted) {
      video.muted = true;
      log("已静音");
    }
  }

  // ============ 确保视频播放 ============
  function ensurePlaying() {
    if (STATE.switchingVideo) return; // 正在切换中,不要干扰
    const video = getVideo();
    if (!video || !video.paused || isQuizDialogOpen()) return;

    // 方案1: 先尝试点击 xgplayer 的开始按钮覆盖层
    // xgplayer 在 autoplay=false 时会显示 xg-start 覆盖层, video.play() 无法绕过
    const startBtn = document.querySelector(
      'xg-start:not(.hide), .xgplayer-start:not(.hide)'
    );
    if (startBtn) {
      log("点击 xgplayer 开始按钮");
      startBtn.click();
      // 点击后等一下再设置倍速
      setTimeout(() => {
        setPlaybackRate();
        muteVideo();
      }, 300);
      return;
    }

    // 方案2: 尝试通过 xgplayer 实例播放 (状态同步更好)
    const xgPlayer = getXgPlayer();
    if (xgPlayer && typeof xgPlayer.play === 'function') {
      try {
        xgPlayer.play();
        return;
      } catch (e) { /* fallback to video.play */ }
    }

    // 方案3: 直接调原生 video.play(), 先确保 muted (有助于通过 autoplay policy)
    video.muted = true;
    const playPromise = video.play();
    if (playPromise) {
      playPromise.catch((err) => {
        log(`play() 被阻止: ${err.name}, 尝试点击播放按钮`, "warn");
        // 方案4: 模拟点击播放器中间的播放按钮
        clickPlayerPlayButton();
      });
    }
  }

  // 获取 xgplayer 实例
  function getXgPlayer() {
    const vm = getCourseVm();
    if (vm && vm.player) return vm.player;
    // 备选: 从 DOM 上找
    const container = document.querySelector('.xgplayer');
    if (container && container.__player) return container.__player;
    return null;
  }

  // 点击播放器的播放按钮 (各种选择器兜底)
  function clickPlayerPlayButton() {
    const selectors = [
      'xg-start',                           // xgplayer 开始覆盖层
      '.xgplayer-start',                     // class 版
      '.xgplayer-play',                      // 播放按钮
      '.xgplayer [class*="play"]',           // 通配
      '.xgplayer-controls .xgplayer-icon',   // 控制栏图标
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        log("已点击播放按钮 (DOM fallback)");
        return true;
      }
    }
    return false;
  }

  // ============ 检测随堂测验弹窗 ============
  function isQuizDialogOpen() {
    // el-dialog with title "随堂练习"
    const dialogs = document.querySelectorAll(".el-dialog__wrapper");
    for (const d of dialogs) {
      if (d.style.display !== "none" && d.querySelector(".el-dialog")) {
        const title = d.querySelector(".el-dialog__title");
        if (title && title.textContent.includes("随堂练习")) {
          return d;
        }
      }
    }
    return null;
  }

  // ============ 自动答题 ============
  function handleQuiz() {
    if (!CONFIG.autoAnswer) return;
    if (STATE.handlingQuiz) return; // 防重入

    const dialog = isQuizDialogOpen();
    if (!dialog) return;

    STATE.handlingQuiz = true;
    log("检测到随堂测验弹窗", "warn");

    setTimeout(() => {
      try {
        // 获取 Vue 实例来拿到当前题目信息
        const vueDialog = findVueComponent(dialog, "PopQuizDialog");

        if (vueDialog) {
          answerViaVue(vueDialog);
        } else {
          answerViaDOM(dialog);
        }
      } catch (e) {
        log(`答题出错: ${e.message}`, "error");
        // fallback: 尝试关闭弹窗
        trySkipQuiz(dialog);
      } finally {
        // 10秒后解除锁, 防止永久卡住
        setTimeout(() => { STATE.handlingQuiz = false; }, 10000);
      }
    }, CONFIG.answerDelay);
  }

  // 通过 Vue 实例答题
  function answerViaVue(comp) {
    const item = comp.item || comp.$props?.item;
    if (!item) {
      log("无法获取题目数据, 尝试 DOM 方式", "warn");
      return;
    }

    const cached = STATE.quizAnswerMap[item.id];
    if (cached) {
      log(`找到缓存答案: ${cached.answer}`, "success");

      // 设置答案
      if (cached.type === 1) {
        // 单选题
        comp.localAnswer = cached.answer;
      } else if (cached.type === 2 || cached.type === 6) {
        // 多选题
        comp.checkList = cached.answer.split(",");
      } else if (cached.type === 3) {
        // 判断题
        comp.localAnswer = cached.answer;
      }

      // 延迟点击提交
      setTimeout(() => {
        const submitBtn = document.querySelector(
          '.el-dialog__wrapper:not([style*="display: none"]) .el-button--primary',
        );
        if (submitBtn) {
          submitBtn.click();
          log("已提交答案", "success");

          // 等待结果后关闭弹窗
          setTimeout(() => {
            closeQuizDialog();
          }, 1500);
        }
      }, 800);
    } else {
      log("未找到缓存答案, 尝试从 DOM 获取", "warn");
      answerViaDOM(document);
    }
  }

  // 通过 DOM 答题 (备选方案)
  function answerViaDOM(container) {
    // 查找单选题选项
    const radioLabels = container.querySelectorAll(
      ".el-radio-group .el-radio",
    );
    if (radioLabels.length > 0) {
      // 尝试从缓存的 quizAnswerMap 中查找匹配的答案
      let answered = false;

      for (const [quizId, info] of Object.entries(STATE.quizAnswerMap)) {
        const answerIndex = info.answer.charCodeAt(0) - "A".charCodeAt(0);
        if (answerIndex >= 0 && answerIndex < radioLabels.length) {
          radioLabels[answerIndex].click();
          log(`DOM方式选择答案: ${info.answer}`, "success");
          answered = true;
          break;
        }
      }

      if (!answered) {
        // 没有缓存答案, 随机选一个 (选B, 统计学上B概率较高)
        const fallbackIndex = Math.min(1, radioLabels.length - 1);
        radioLabels[fallbackIndex].click();
        log("未找到正确答案, 已选择默认选项B", "warn");
      }

      setTimeout(() => {
        const submitBtn = container.querySelector(
          ".el-button--primary:not(.is-disabled)",
        );
        if (submitBtn) {
          submitBtn.click();
          log("已提交答案 (DOM方式)");

          setTimeout(() => closeQuizDialog(), 1500);
        }
      }, 800);
    }
  }

  // 关闭测验弹窗
  function closeQuizDialog() {
    // ===== 方案1 (最可靠): 通过 Vue 组件实例直接关闭 =====
    const quizComp = findPopQuizComponent();
    if (quizComp) {
      const state = quizComp.answerState;
      log(`答题状态: answerState=${state}`);

      if (state === 3) {
        // 答错了
        if (quizComp.isMustRight === 2) {
          // 不要求必须答对, 可以跳过
          log("答错但可跳过, 直接关闭", "warn");
          quizComp.closeDialog();
        } else {
          // 必须答对, 重新作答
          log("答错且必须答对, 重新作答", "warn");
          quizComp.reAnswer();
          STATE.handlingQuiz = false;
          setTimeout(() => handleQuiz(), 1500);
          return;
        }
      } else {
        // 答对了 (state===2) 或其他状态, 直接关闭
        log("回答正确, 通过 Vue 关闭弹窗", "success");
        quizComp.closeDialog();
      }

      // 同时关闭父组件的 popQuizDialog.visible
      const vm = getCourseVm();
      if (vm && vm.popQuizDialog) {
        vm.popQuizDialog.visible = false;
      }

      STATE.handlingQuiz = false;
      retryPlay("答题后恢复播放");
      return;
    }

    // ===== 方案2: DOM 点击按钮 =====
    log("未找到 Vue 组件, 尝试 DOM 方式关闭", "warn");
    const dialogs = document.querySelectorAll(
      '.el-dialog__wrapper:not([style*="display: none"])',
    );
    for (const d of dialogs) {
      const title = d.querySelector(".el-dialog__title");
      if (!title || !title.textContent.includes("随堂练习")) continue;

      // 从 dialog-footer 和整个弹窗中查找所有按钮
      const btns = d.querySelectorAll(".el-button");
      log(`弹窗中找到 ${btns.length} 个按钮: ${[...btns].map(b => b.textContent.trim()).join(', ')}`);

      // 先查: 答错了要重新作答
      for (const btn of btns) {
        const text = btn.textContent.trim();
        if (text.includes("再试") || text.includes("重新")) {
          btn.click();
          log("答错了, 再试一次", "warn");
          STATE.handlingQuiz = false;
          setTimeout(() => handleQuiz(), 1500);
          return;
        }
      }

      // 再查: 关闭/跳过/继续/确定 — 任意一个都行
      for (const btn of btns) {
        const text = btn.textContent.trim();
        if (text.includes("关闭") || text.includes("跳过") ||
            text.includes("继续") || text.includes("确定") ||
            text.includes("知道")) {
          btn.click();
          log(`已点击 [${text}] 关闭弹窗`, "success");
          STATE.handlingQuiz = false;
          retryPlay("答题后恢复播放");
          return;
        }
      }

      // 兜底: 弹窗里有按钮但都没匹配上, 点第一个 primary 按钮
      const primaryBtn = d.querySelector('.el-button--primary');
      if (primaryBtn) {
        primaryBtn.click();
        log(`兜底: 点击了 primary 按钮 [${primaryBtn.textContent.trim()}]`, "warn");
        STATE.handlingQuiz = false;
        retryPlay("答题后恢复播放");
        return;
      }
    }

    log("未能关闭弹窗, 将在下次循环重试", "warn");
    STATE.handlingQuiz = false; // 解锁让下次循环重试
  }

  // 查找 PopQuizDialog 的 Vue 组件实例
  function findPopQuizComponent() {
    // 从打开的 dialog 元素向上找 Vue 实例
    const dialogs = document.querySelectorAll('.el-dialog__wrapper');
    for (const d of dialogs) {
      if (d.style.display === 'none') continue;
      const title = d.querySelector('.el-dialog__title');
      if (!title || !title.textContent.includes('随堂练习')) continue;

      // 在 dialog 内找带 __vue__ 的元素
      const els = d.querySelectorAll('*');
      for (const el of els) {
        if (el.__vue__) {
          const vm = el.__vue__;
          // PopQuizDialog 特征: 有 answerState, closeDialog, localAnswer
          if (typeof vm.answerState !== 'undefined' && typeof vm.closeDialog === 'function') {
            return vm;
          }
          // 检查父级
          let parent = vm.$parent;
          while (parent) {
            if (typeof parent.answerState !== 'undefined' && typeof parent.closeDialog === 'function') {
              return parent;
            }
            parent = parent.$parent;
          }
        }
      }
    }
    return null;
  }

  // 跳过测验 (当 isSkip=1 时可用)
  function trySkipQuiz(dialog) {
    const btns = dialog.querySelectorAll(".el-button");
    for (const btn of btns) {
      if (
        btn.textContent.includes("跳过") ||
        btn.textContent.includes("关闭")
      ) {
        btn.click();
        log("已跳过测验");
        return;
      }
    }
  }

  // 查找 Vue 组件实例
  function findVueComponent(el, name) {
    if (!el) return null;

    // 尝试从 DOM 元素获取 Vue 实例
    const allEls = el.querySelectorAll("*");
    for (const child of allEls) {
      if (child.__vue__) {
        const vm = child.__vue__;
        if (
          vm.$options &&
          (vm.$options.name === name || vm.$options._componentTag === name)
        ) {
          return vm;
        }
        // 检查父组件
        if (
          vm.$parent &&
          vm.$parent.$options &&
          (vm.$parent.$options.name === name ||
            vm.$parent.$options._componentTag === name)
        ) {
          return vm.$parent;
        }
      }
    }
    return null;
  }

  // ============ 获取课程 Vue 实例 ============
  function getCourseVm() {
    const app = document.querySelector("#app");
    if (app && app.__vue__) {
      // 遍历寻找包含 catalogue 的组件
      function findComponent(vm) {
        if (vm.catalogue && vm.recordProcess) return vm;
        if (vm.$children) {
          for (const child of vm.$children) {
            const found = findComponent(child);
            if (found) return found;
          }
        }
        return null;
      }
      return findComponent(app.__vue__);
    }
    return null;
  }

  // ============ 自动切换下一节 ============
  function handleVideoEnd() {
    if (!CONFIG.autoNext) return;
    if (STATE.switchingVideo) return; // 防重入

    const video = getVideo();
    if (!video) return;

    // 检查视频是否播放完毕
    if (video.ended || (video.duration > 0 && video.currentTime >= video.duration - 1)) {
      // 防止同一个视频重复触发
      const videoSrc = video.src || video.currentSrc;
      if (videoSrc && videoSrc === STATE.lastEndedVideoSrc) return;
      STATE.lastEndedVideoSrc = videoSrc;
      STATE.switchingVideo = true;

      log("当前视频播放完毕, 准备切换下一节...", "success");
      STATE.totalCompleted++;

      setTimeout(() => {
        switchToNextVideo();
      }, CONFIG.nextVideoDelay);
    }
  }

  // 切换到下一个视频
  function switchToNextVideo() {
    // 方案1: 通过 Vue 实例切换
    const vm = getCourseVm();
    if (vm && vm.catalogue) {
      const allNodes = [];
      vm.catalogue.forEach((chap) => {
        if (chap.nodeVoList) {
          chap.nodeVoList.forEach((node) => {
            if (node.type === "1") {
              // type 1 = 视频
              allNodes.push(node);
            }
          });
        }
      });

      // 找到当前正在播放的节点
      const currentId = vm.dataItem?.id || vm.currentPlayingVideo?.id;
      const currentIdx = allNodes.findIndex((n) => n.id === currentId);

      if (currentIdx >= 0 && currentIdx < allNodes.length - 1) {
        const nextNode = allNodes[currentIdx + 1];
        log(`切换到: ${nextNode.name}`);
        STATE.currentNode = nextNode.name;

        // 通过 Vue 实例的方法切换
        if (typeof vm.handleNodeClick === "function") {
          vm.handleNodeClick(nextNode);
          // 切换后等待新播放器就绪, 然后自动播放
          waitForNewVideoAndPlay();
          return;
        }
      } else if (currentIdx >= allNodes.length - 1) {
        log("当前课程所有视频已播放完毕!", "success");
        // 尝试跳转到同分类下一门课程
        switchToNextCourse();
        return;
      }
    }

    // 方案2: 通过 DOM 点击下一个视频
    clickNextVideoInDOM();
    waitForNewVideoAndPlay();
  }

  // ============ 跳转到同分类下一门课程 ============
  async function switchToNextCourse() {
    log("正在查找下一门课程...", "warn");

    try {
      // 1. 获取当前课程信息 (从 sessionStorage 拿 currid)
      const currid = JSON.parse(sessionStorage.getItem("currid"));
      if (!currid) {
        log("无法获取当前课程 ID", "error");
        finishAll();
        return;
      }

      // 2. 获取当前课程详情, 拿到 classifySubId 和 sort
      const detailResp = await fetch(
        `https://gateway.shengshengketang.com/api/course/curriculum/tourist/selectDetail/${currid}`,
        { headers: { "Content-Type": "application/json" } }
      ).then(r => r.json());

      if (detailResp.code !== 200 || !detailResp.data) {
        log("获取课程详情失败", "error");
        finishAll();
        return;
      }

      const currentCourse = detailResp.data;
      const subClassifyId = currentCourse.classifySubId;
      const currentSort = parseInt(currentCourse.sort) || 0;
      log(`当前课程: ${currentCourse.name} (sort=${currentSort}, 分类=${subClassifyId})`);

      if (!subClassifyId) {
        log("当前课程没有分类信息, 无法查找下一门", "warn");
        finishAll();
        return;
      }

      // 3. 获取同分类下的所有课程列表
      const listResp = await fetch(
        `https://gateway.shengshengketang.com/api/course/online/schoolandcourse/selectListCourseByOc?limit=50&page=1&subClassifyId=${subClassifyId}`,
        { headers: { "Content-Type": "application/json" } }
      ).then(r => r.json());

      if (listResp.code !== 200 || !listResp.data || !listResp.data.data) {
        log("获取课程列表失败", "error");
        finishAll();
        return;
      }

      const allCourses = listResp.data.data;
      log(`同分类共 ${allCourses.length} 门课程`);

      // 4. 按 sort 排序, 找到当前课程之后第一个未完成的
      const sorted = allCourses
        .map(c => ({ ...c, sortNum: parseInt(c.sort) || 999 }))
        .sort((a, b) => a.sortNum - b.sortNum);

      let nextCourse = null;
      for (const course of sorted) {
        if (course.sortNum > currentSort && course.finishPercentage < 100) {
          nextCourse = course;
          break;
        }
      }

      if (!nextCourse) {
        // 没有更高 sort 的未完成课程, 找任意未完成的
        nextCourse = sorted.find(c => c.id !== currid && c.finishPercentage < 100);
      }

      if (!nextCourse) {
        log("该分类下所有课程已完成!", "success");
        finishAll();
        return;
      }

      // 5. 跳转到下一门课程
      log(`即将跳转到: ${nextCourse.name} (sort=${nextCourse.sort})`, "success");
      STATE.totalCompleted = 0; // 重置当前课程计数
      showNotification(`课程完成! 即将开始: ${nextCourse.name}`);

      // 模拟网站的跳转方式:
      // sessionStorage 设置新的 currid, 然后 router.push 到 videoDetail 页面
      sessionStorage.setItem("currid", JSON.stringify(nextCourse.id));

      // 尝试通过 Vue Router 跳转
      const app = document.querySelector("#app");
      if (app && app.__vue__ && app.__vue__.$router) {
        app.__vue__.$router.push({ path: "/onlineStudent/videoDetail" });
        // 网站源码在跳转后会 reload, 我们也这样做确保状态干净
        setTimeout(() => {
          STATE.switchingVideo = false;
          STATE.lastEndedVideoSrc = null;
          // 等页面加载完后, 新的脚本实例会自动启动
          // 但因为是 SPA, 可能不会重新加载脚本, 所以等待新的 catalogue 加载后自动播放
          waitForNewCourseLoaded();
        }, 2000);
      } else {
        // 备选: 直接修改 URL
        window.location.href = `https://www.shengshengketang.com/onlineStudent/videoDetail`;
      }

    } catch (e) {
      log(`跳转下一门课程出错: ${e.message}`, "error");
      STATE.switchingVideo = false;
    }
  }

  // 等待新课程页面加载完毕后自动开始播放
  function waitForNewCourseLoaded() {
    let attempts = 0;
    const maxAttempts = 40; // 20 秒

    const checker = setInterval(() => {
      attempts++;
      const vm = getCourseVm();

      if (vm && vm.catalogue && vm.catalogue.length > 0) {
        clearInterval(checker);
        log("新课程已加载, 开始播放第一个视频", "success");
        STATE.switchingVideo = false;
        STATE.lastEndedVideoSrc = null;

        // 找到第一个未完成的视频
        const allNodes = [];
        vm.catalogue.forEach(chap => {
          if (chap.nodeVoList) {
            chap.nodeVoList.forEach(node => {
              if (node.type === "1") allNodes.push(node);
            });
          }
        });

        const firstUnfinished = allNodes.find(n => n.isFinish !== 1) || allNodes[0];
        if (firstUnfinished && typeof vm.handleNodeClick === 'function') {
          STATE.currentNode = firstUnfinished.name;
          log(`播放: ${firstUnfinished.name}`);
          vm.handleNodeClick(firstUnfinished);
          waitForNewVideoAndPlay();
        }
      }

      if (attempts >= maxAttempts) {
        clearInterval(checker);
        STATE.switchingVideo = false;
        log("等待新课程加载超时", "warn");
      }
    }, 500);
  }

  // 全部完成
  function finishAll() {
    STATE.running = false;
    STATE.switchingVideo = false;
    updatePanel();
    showNotification("全部课程已完成!");
    log("所有课程已完成! 可以停止挂课了.", "success");
  }

  // 等待新播放器创建完成后自动播放
  function waitForNewVideoAndPlay() {
    let attempts = 0;
    const maxAttempts = 30; // 最多等 15 秒 (30 * 500ms)

    const checker = setInterval(() => {
      attempts++;
      const video = getVideo();

      if (video && video.readyState >= 1) {
        // 有新视频且至少有 metadata
        clearInterval(checker);
        STATE.switchingVideo = false;
        STATE.lastEndedVideoSrc = null; // 重置, 允许新视频的 ended 检测

        log("新视频已就绪, 尝试自动播放...");
        retryPlay("切换后自动播放");
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(checker);
        STATE.switchingVideo = false;
        STATE.lastEndedVideoSrc = null;
        log("等待新视频超时, 尝试强制播放", "warn");
        retryPlay("超时后强制播放");
      }
    }, 500);
  }

  // 带重试的播放 (解决 xgplayer 新建播放器后需要手动点击的问题)
  function retryPlay(reason) {
    let retries = 0;
    const maxRetries = 10;

    const tryOnce = () => {
      retries++;
      const video = getVideo();

      if (!video) {
        if (retries < maxRetries) setTimeout(tryOnce, 800);
        return;
      }

      if (!video.paused) {
        // 已经在播放了
        setPlaybackRate();
        muteVideo();
        log(`${reason}: 已在播放`, "success");
        return;
      }

      // 优先先 muted (Chrome autoplay policy: muted 视频可以自动播放)
      video.muted = true;

      // 尝试点击 xgplayer 的大播放按钮
      const startBtn = document.querySelector(
        'xg-start:not(.hide), .xgplayer-start:not(.hide)'
      );
      if (startBtn) {
        startBtn.click();
        log(`${reason}: 点击了 xgplayer 开始按钮 (第${retries}次)`);
      }

      // 同时也尝试 xgplayer 实例播放
      const xgPlayer = getXgPlayer();
      if (xgPlayer && typeof xgPlayer.play === 'function') {
        try { xgPlayer.play(); } catch(e) {}
      }

      // 也尝试原生 play
      const p = video.play();
      if (p) p.catch(() => {});

      // 检查是否真的开始播放了
      setTimeout(() => {
        const v = getVideo();
        if (v && v.paused && retries < maxRetries) {
          log(`${reason}: 第${retries}次尝试未成功, 继续重试...`, "warn");
          tryOnce();
        } else if (v && !v.paused) {
          setPlaybackRate();
          muteVideo();
          log(`${reason}: 播放成功 (第${retries}次)`, "success");
        }
      }, 600);
    };

    // 首次延迟 1 秒, 等待播放器初始化
    setTimeout(tryOnce, 1000);
  }

  // DOM 方式点击下一个视频
  function clickNextVideoInDOM() {
    // 查找左侧目录中当前播放的项
    const activeItem = document.querySelector(
      ".node-item.active, .node-item.playing, .video-item.active, .is-current",
    );
    if (activeItem) {
      const nextItem = activeItem.nextElementSibling;
      if (nextItem) {
        nextItem.click();
        log("已点击下一个视频 (DOM方式)");
        return;
      }
    }

    // 尝试查找所有课程节点并点击下一个
    const nodeItems = document.querySelectorAll(
      '.node-item, .video-item, [class*="node"]',
    );
    let foundCurrent = false;
    for (const item of nodeItems) {
      if (foundCurrent) {
        item.click();
        log("已切换到下一个视频");
        return;
      }
      if (
        item.classList.contains("active") ||
        item.classList.contains("playing")
      ) {
        foundCurrent = true;
      }
    }

    log("未找到下一个视频节点", "warn");
  }

  // ============ 主循环 ============
  function mainLoop() {
    if (!STATE.running) return;

    try {
      // 1. 确保播放速度
      setPlaybackRate();

      // 2. 静音
      muteVideo();

      // 3. 确保在播放
      ensurePlaying();

      // 4. 检查随堂测验
      handleQuiz();

      // 5. 检查视频结束
      handleVideoEnd();

      // 6. 更新面板信息
      updateVideoInfo();
    } catch (e) {
      log(`主循环错误: ${e.message}`, "error");
    }
  }

  // 更新视频信息
  function updateVideoInfo() {
    const video = getVideo();
    if (video && video.duration) {
      const current = formatTime(video.currentTime);
      const total = formatTime(video.duration);
      const percent = ((video.currentTime / video.duration) * 100).toFixed(1);
      const infoEl = document.getElementById("ac-video-info");
      if (infoEl) {
        infoEl.textContent = `${current} / ${total} (${percent}%)`;
      }
    }
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  // ============ 桌面通知 ============
  function showNotification(msg) {
    if (Notification.permission === "granted") {
      new Notification("挂课助手", { body: msg });
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") new Notification("挂课助手", { body: msg });
      });
    }
  }

  // ============ 控制面板 UI ============
  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "ac-panel";
    panel.innerHTML = `
      <style>
        #ac-panel {
          position: fixed;
          top: 10px;
          right: 10px;
          width: 320px;
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          border: 1px solid #0f3460;
          border-radius: 12px;
          color: #e0e0e0;
          font-family: -apple-system, sans-serif;
          font-size: 13px;
          z-index: 99999;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          user-select: none;
          overflow: hidden;
        }
        #ac-panel-header {
          background: linear-gradient(90deg, #0f3460, #533483);
          padding: 10px 14px;
          cursor: move;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        #ac-panel-header span {
          font-weight: bold;
          font-size: 14px;
          color: #fff;
        }
        #ac-panel-body {
          padding: 12px 14px;
        }
        .ac-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .ac-label { color: #aaa; }
        .ac-value { color: #4fc3f7; font-weight: bold; }
        .ac-btn {
          padding: 6px 16px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: bold;
          transition: all 0.2s;
        }
        .ac-btn-start {
          background: linear-gradient(90deg, #00b894, #00cec9);
          color: #fff;
        }
        .ac-btn-start:hover { opacity: 0.85; }
        .ac-btn-stop {
          background: linear-gradient(90deg, #e17055, #d63031);
          color: #fff;
        }
        .ac-btn-stop:hover { opacity: 0.85; }
        .ac-btn-minimize {
          background: none;
          border: none;
          color: #fff;
          cursor: pointer;
          font-size: 18px;
          padding: 0 4px;
        }
        .ac-speed-bar {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }
        .ac-speed-btn {
          padding: 3px 8px;
          border: 1px solid #3a3a5c;
          border-radius: 4px;
          background: rgba(255,255,255,0.05);
          color: #aaa;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.15s;
        }
        .ac-speed-btn:hover {
          border-color: #4fc3f7;
          color: #4fc3f7;
        }
        .ac-speed-btn.active {
          background: linear-gradient(90deg, #0f3460, #533483);
          border-color: #4fc3f7;
          color: #fff;
          font-weight: bold;
        }
        #ac-log {
          max-height: 120px;
          overflow-y: auto;
          background: rgba(0,0,0,0.3);
          border-radius: 6px;
          padding: 6px 8px;
          margin-top: 8px;
          font-size: 11px;
          line-height: 1.5;
          color: #aaa;
        }
        #ac-log::-webkit-scrollbar { width: 4px; }
        #ac-log::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
        .ac-status-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-right: 6px;
          animation: ac-pulse 1.5s infinite;
        }
        .ac-status-running { background: #00b894; }
        .ac-status-stopped { background: #d63031; animation: none; }
        @keyframes ac-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      </style>
      <div id="ac-panel-header">
        <span>🎓 自动挂课助手</span>
        <div>
          <button class="ac-btn-minimize" id="ac-minimize">—</button>
        </div>
      </div>
      <div id="ac-panel-body">
        <div class="ac-row">
          <span class="ac-label">状态</span>
          <span class="ac-value" id="ac-status">
            <span class="ac-status-dot ac-status-stopped"></span>已停止
          </span>
        </div>
        <div class="ac-row">
          <span class="ac-label">播放速度</span>
          <div class="ac-speed-bar" id="ac-speed-bar">
            ${CONFIG.speedOptions.map(s =>
              `<button class="ac-speed-btn ${s === CONFIG.playbackRate ? 'active' : ''}" data-speed="${s}">${s}x</button>`
            ).join('')}
          </div>
        </div>
        <div class="ac-row">
          <span class="ac-label">当前进度</span>
          <span class="ac-value" id="ac-video-info">--:-- / --:--</span>
        </div>
        <div class="ac-row">
          <span class="ac-label">已完成</span>
          <span class="ac-value" id="ac-completed">0 节</span>
        </div>
        <div class="ac-row">
          <span class="ac-label">当前节</span>
          <span class="ac-value" id="ac-current-node" style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">-</span>
        </div>
        <div style="text-align:center;margin-top:10px;">
          <button class="ac-btn ac-btn-start" id="ac-toggle">▶ 开始挂课</button>
        </div>
        <div id="ac-log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // 拖拽
    makeDraggable(panel, document.getElementById("ac-panel-header"));

    // 最小化
    document.getElementById("ac-minimize").addEventListener("click", () => {
      const body = document.getElementById("ac-panel-body");
      body.style.display = body.style.display === "none" ? "block" : "none";
    });

    // 倍速按钮
    document.getElementById("ac-speed-bar").addEventListener("click", (e) => {
      const btn = e.target.closest(".ac-speed-btn");
      if (!btn) return;
      const speed = parseFloat(btn.dataset.speed);
      CONFIG.playbackRate = speed;

      // 更新按钮样式
      document.querySelectorAll(".ac-speed-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      // 立即生效
      const video = getVideo();
      if (video) {
        video.playbackRate = speed;
      }
      log(`倍速切换为 ${speed}x`, "success");
    });

    // 开始/停止按钮
    document.getElementById("ac-toggle").addEventListener("click", toggleRun);
  }

  function toggleRun() {
    STATE.running = !STATE.running;
    const btn = document.getElementById("ac-toggle");

    if (STATE.running) {
      btn.textContent = "⏸ 停止挂课";
      btn.className = "ac-btn ac-btn-stop";
      log("挂课已启动", "success");

      // 立即执行一次
      mainLoop();
    } else {
      btn.textContent = "▶ 开始挂课";
      btn.className = "ac-btn ac-btn-start";
      log("挂课已停止");
    }
    updatePanel();
  }

  function updatePanel() {
    const statusEl = document.getElementById("ac-status");
    if (statusEl) {
      statusEl.innerHTML = STATE.running
        ? '<span class="ac-status-dot ac-status-running"></span>运行中'
        : '<span class="ac-status-dot ac-status-stopped"></span>已停止';
    }

    const completedEl = document.getElementById("ac-completed");
    if (completedEl) completedEl.textContent = `${STATE.totalCompleted} 节`;

    const nodeEl = document.getElementById("ac-current-node");
    if (nodeEl)
      nodeEl.textContent = STATE.currentNode || getCurrentNodeName() || "-";

    const logEl = document.getElementById("ac-log");
    if (logEl) {
      logEl.innerHTML = STATE.log
        .slice(-10)
        .map((l) => `<div>${l}</div>`)
        .join("");
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function getCurrentNodeName() {
    const vm = getCourseVm();
    if (vm && vm.dataItem) {
      return vm.dataItem.name || "";
    }
    return "";
  }

  // 拖拽功能
  function makeDraggable(el, handle) {
    let isDragging = false,
      startX,
      startY,
      origX,
      origY;

    handle.addEventListener("mousedown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      el.style.left = origX + (e.clientX - startX) + "px";
      el.style.top = origY + (e.clientY - startY) + "px";
      el.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });
  }

  // ============ 初始化 ============
  function init() {
    console.log(
      "%c[挂课助手] 声声课堂自动挂课助手已加载",
      "color:#00b894;font-size:16px;font-weight:bold",
    );

    // 拦截 API 获取题目答案
    interceptXHR();

    // 创建控制面板
    createPanel();

    // 启动主循环定时器
    setInterval(mainLoop, CONFIG.progressInterval);

    // 监听视频元素变化 (SPA页面切换时视频元素会变)
    const observer = new MutationObserver(() => {
      const video = getVideo();
      if (video && !video._acHooked) {
        video._acHooked = true;
        log("检测到新的 video 元素");

        video.addEventListener("play", () => {
          setPlaybackRate();
          muteVideo();
          log(`视频开始播放`);
        });

        video.addEventListener("ended", () => {
          if (STATE.running) {
            log("视频播放结束 (ended 事件)");
            handleVideoEnd();
          }
        });

        video.addEventListener("ratechange", () => {
          if (
            STATE.running &&
            video.playbackRate !== CONFIG.playbackRate
          ) {
            video.playbackRate = CONFIG.playbackRate;
          }
        });

        // 关键: 新视频 canplay 后自动播放
        video.addEventListener("canplay", () => {
          if (STATE.running && video.paused && !isQuizDialogOpen()) {
            log("新视频 canplay, 尝试自动播放");
            video.muted = true; // muted 有助于通过 autoplay policy
            const p = video.play();
            if (p) p.catch(() => {
              // play 被阻止, 尝试点击按钮
              setTimeout(() => clickPlayerPlayButton(), 300);
            });
            setTimeout(() => {
              setPlaybackRate();
              muteVideo();
            }, 200);
          }
        }, { once: true }); // 只在第一次 canplay 时触发

        // 初始设置
        if (STATE.running) {
          video.muted = true;
          setPlaybackRate();
          muteVideo();
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // 请求通知权限
    if (Notification.permission === "default") {
      Notification.requestPermission();
    }

    log("助手已就绪, 点击 [开始挂课] 启动");
  }

  // 等待页面加载完成
  if (document.readyState === "complete") {
    setTimeout(init, 1000);
  } else {
    window.addEventListener("load", () => setTimeout(init, 1000));
  }
})();
