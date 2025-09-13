const mineflayer = require('mineflayer');
const colors = require('colors');
const { Command } = require('commander');
const readline = require('readline');

// 命令行参数解析
const program = new Command();
program
  .option('-s, --server <address>', '服务器地址 (格式: IP:端口)', 'localhost:25565')
  .option('-n, --num <number>', '添加的假人数量', '5')
  .option('-f, --prefix <text>', '机器人名字的前缀', 'bot_')
  .parse(process.argv);
const options = program.opts();

// 解析服务器地址和端口
const [defaultServerIP, defaultServerPortStr] = options.server.split(':');
const defaultServerPort = defaultServerPortStr ? parseInt(defaultServerPortStr, 10) : 25565;
const bot_number = options.num;
const bot_prefix = options.prefix;

// 连接配置
const CONFIG = {
  MAX_CONCURRENT_CONNECTIONS: 3,
  CONNECTION_DELAY: 300,
  INITIAL_RETRY_DELAY: 2000,
  MAX_RETRY_DELAY: 10000,
  MAX_RETRY_ATTEMPTS: 5,
  CONNECTION_TIMEOUT: 20000,
};

// 全局状态
let bots = [];
let isStartingBots = false;
let botServiceRunning = false;
let allBotsConnected = false;
let maintenanceMode = false;
let serverIP = defaultServerIP;
let serverPort = defaultServerPort;
let connectionQueue = [];
let activeConnections = 0;

// 控制台输入
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
});

// 日志函数
function log(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  let formattedMessage = `[${timestamp}] [${level}] ${message}`;
  
  switch (level) {
    case 'success': console.log(colors.green(formattedMessage)); break;
    case 'error': console.log(colors.red(formattedMessage)); break;
    case 'warning': console.log(colors.yellow(formattedMessage)); break;
    case 'maintenance': console.log(colors.magenta(formattedMessage)); break;
    case 'chat': console.log(colors.white(formattedMessage)); break;
    default: console.log(colors.cyan(formattedMessage));
  }
}

// 处理连接队列
function processConnectionQueue() {
  if (connectionQueue.length === 0 || activeConnections >= CONFIG.MAX_CONCURRENT_CONNECTIONS) return;

  const nextConnection = connectionQueue.shift();
  activeConnections++;
  log(`开始连接假人 ${nextConnection.username} (${activeConnections}个活跃连接)`, 'info');
  nextConnection.connect();
}

// 创建假人函数
function createBot(username, isMainListener, server, port) {
  log(`准备创建假人 ${username}，将连接到 ${server}:${port}`, 'info');
  
  const botWrapper = {
    username: username,
    isOnline: false,
    isConnected: false,
    isFirstSpawn: true,
    manualDisconnect: false,
    quit: () => {},
    chat: () => {}
  };

  let bot = null;
  let retryCount = 0;
  let retryDelay = CONFIG.INITIAL_RETRY_DELAY;
  
  const connectFunction = () => {
    if (bot) {
      try {
        bot.removeAllListeners();
        bot.quit();
      } catch (e) {}
    }
    
    bot = mineflayer.createBot({
      host: server,
      port: port,
      username: username,
      auth: 'offline',
      respawn: true,
      quitOnEnd: false,
      family: 4,
      connectTimeout: CONFIG.CONNECTION_TIMEOUT
    });

    const connectionTimeout = setTimeout(() => {
      if (botWrapper.isFirstSpawn) {
        log(`假人 ${username} 连接超时`, 'error');
        handleConnectionFailure();
      }
    }, CONFIG.CONNECTION_TIMEOUT);

    bot.on('spawn', () => {
      clearTimeout(connectionTimeout);
      retryCount = 0;
      retryDelay = CONFIG.INITIAL_RETRY_DELAY;
      
      if (botWrapper.isFirstSpawn) {
        botWrapper.isFirstSpawn = false;
        botWrapper.isOnline = true;
        botWrapper.isConnected = true;
        log(`假人 ${username} 首次连接成功`, 'success');
        activeConnections--;
        processConnectionQueue();
        checkAllBotsConnected();
      } else {
        log(`假人 ${username} 已重生或重连`, 'warning');
        botWrapper.isOnline = true;
        botWrapper.isConnected = true;
      }
      
      botWrapper.manualDisconnect = false;
    });

    bot.on('connect', () => {
      clearTimeout(connectionTimeout);
      botWrapper.isConnected = true;
      if (botWrapper.isFirstSpawn) {
        log(`假人 ${username} 正在登录服务器...`, 'info');
      }
    });

    bot.on('end', () => {
      log(`假人 ${username} 与服务器断开连接`, 'error');
      botWrapper.isOnline = false;
      botWrapper.isConnected = false;
      
      if (!botWrapper.manualDisconnect && !botWrapper.isFirstSpawn && botServiceRunning) {
        setTimeout(() => {
          if (botServiceRunning && !botWrapper.manualDisconnect) {
            connectFunction();
          }
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 1.5, CONFIG.MAX_RETRY_DELAY);
      }
    });

    bot.on('error', (err) => {
      clearTimeout(connectionTimeout);
      log(`假人 ${username} 发生错误: ${err.message}`, 'error');
      botWrapper.isOnline = false;
      botWrapper.isConnected = false;
      handleConnectionFailure();
    });

    if (isMainListener) {
      bot.on('chat', (user, message) => {
        if (user === bot.username) return;
        log(`${user}: ${message}`, 'chat');
      });
    }
    
    botWrapper.quit = () => {
      botWrapper.manualDisconnect = true;
      if (bot) bot.quit();
    };
    
    botWrapper.chat = (message) => {
      if (bot && botWrapper.isOnline) {
        bot.chat(message);
      }
    };
  };
  
  const handleConnectionFailure = () => {
    botWrapper.isOnline = false;
    botWrapper.isConnected = false;
    
    if (botWrapper.isFirstSpawn && !botWrapper.manualDisconnect) {
      retryCount++;
      
      if (retryCount >= CONFIG.MAX_RETRY_ATTEMPTS) {
        log(`假人 ${username} 连接失败次数过多，将标记为失败`, 'error');
        botWrapper.isFirstSpawn = false;
        activeConnections--;
        processConnectionQueue();
        checkAllBotsConnected();
      } else {
        const delay = Math.min(
          CONFIG.INITIAL_RETRY_DELAY * Math.pow(1.5, retryCount - 1),
          CONFIG.MAX_RETRY_DELAY
        );
        
        log(`假人 ${username} 将在 ${delay/1000} 秒后重试 (尝试 ${retryCount}/${CONFIG.MAX_RETRY_ATTEMPTS})`, 'warning');
        
        setTimeout(() => {
          if (botServiceRunning && !botWrapper.manualDisconnect) {
            connectFunction();
          }
        }, delay);
      }
    }
  };
  
  connectionQueue.push({
    username: username,
    connect: connectFunction
  });
  
  return botWrapper;
}

// 检查所有假人连接状态
function checkAllBotsConnected() {
  if (bots.length === 0) return;
  
  const firstSpawnedCount = bots.filter(bot => !bot.isFirstSpawn).length;
  const totalCount = bots.length;
  
  if (firstSpawnedCount === totalCount) {
    if (!allBotsConnected) {
      allBotsConnected = true;
      maintenanceMode = false;
      isStartingBots = false;
      
      const connectedCount = bots.filter(bot => bot.isConnected).length;
      
      if (connectedCount === 0) {
        log('所有假人都连接失败，服务已停止', 'error');
        botServiceRunning = false;
      } else if (connectedCount < totalCount) {
        log(`部分假人连接失败，成功连接 ${connectedCount}/${totalCount} 个假人`, 'warning');
        log('现在可以输入命令', 'success');
      } else {
        log('所有假人已成功连接，现在可以输入命令', 'success');
      }
    }
  }
}

// 启动假人服务
function startBots(count, prefix, server, port) {
  if (isStartingBots || botServiceRunning) {
    log('假人服务已在运行中，请等待当前操作完成', 'warning');
    return;
  }
  
  isStartingBots = true;
  botServiceRunning = true;
  allBotsConnected = false;
  maintenanceMode = true;
  connectionQueue = [];
  activeConnections = 0;
  
  log(`正在创建 ${count} 个假人并连接到服务器 ${server}:${port}`, 'info');
  log('假人启动后需要一段时间连接到服务器，请耐心等待...', 'maintenance');
  log('在所有假人连接完成前，命令输入将被禁用', 'maintenance');
  
  bots.forEach(bot => bot.quit());
  bots = [];
  
  let createdCount = 0;
  
  for (let i = 0; i < count; i++) {
    const username = `${prefix}${String(i + 1).padStart(3, '0')}`;
    const isMainListener = i === 0;
    
    setTimeout(() => {
      try {
        const bot = createBot(username, isMainListener, server, port);
        bots.push(bot);
        createdCount++;
        log(`已加入连接队列: ${username} (${createdCount}/${count})`, 'info');
        processConnectionQueue();
        
        if (createdCount === count) {
          isStartingBots = false;
          log(`✅ 所有 ${count} 个假人已加入连接队列！正在按顺序连接到服务器...`, 'success');
          log('请等待所有假人首次连接完成 (这可能需要一段时间)', 'maintenance');
        }
      } catch (error) {
        log(`创建假人 ${username} 时出错: ${error.message}`, 'error');
        isStartingBots = false;
      }
    }, i * 100);
  }
}

// 停止假人服务
function stopBots() {
  if (bots.length === 0) {
    log('当前没有运行中的假人', 'info');
    botServiceRunning = false;
    allBotsConnected = false;
    maintenanceMode = false;
    isStartingBots = false;
    return;
  }
  
  log('🛑 正在停止假人服务，断开所有假人连接...', 'info');
  bots.forEach(bot => bot.quit());
  bots = [];
  connectionQueue = [];
  activeConnections = 0;
  botServiceRunning = false;
  allBotsConnected = false;
  maintenanceMode = false;
  isStartingBots = false;
  log('✅ 假人服务已成功停止', 'success');
}

// 处理控制台命令
function handleCommand(command) {
  const args = command.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  
  if (!cmd) return;

  // 允许stop命令在任何状态下执行
  if (cmd === 'stop') {
    if (botServiceRunning) {
      stopBots();
    } else {
      log('🛑 正在退出程序...', 'info');
      rl.close();
      process.exit(0);
    }
    return;
  }

  if (maintenanceMode) {
    log('当前处于维护模式，请等待所有假人连接完成', 'maintenance');
    return;
  }

  switch (cmd) {
      
    case 'start':
      if (args.length < 4) {
        log('用法: start [数量] [前缀] [服务器地址:端口]', 'error');
        break;
      }
      
      const count = parseInt(args[1], 10);
      const prefix = args[2];
      const server = args[3];
      const [ip, port] = server.split(':');
      
      if (isNaN(count) || count <= 0 || count > 100) {
        log('无效的假人数量 (1-100)', 'error');
        break;
      }
      
      serverIP = ip;
      serverPort = port ? parseInt(port, 10) : 25565;
      startBots(count, prefix, serverIP, serverPort);
      break;

    case 'bots':
      log('当前假人列表:', 'info');
      bots.forEach(bot => {
        const status = bot.isOnline ? '在线' : '离线';
        const statusColor = bot.isOnline ? colors.green : colors.red;
        log(`- ${bot.username}: ${statusColor(status)} ${bot.isFirstSpawn ? colors.yellow('(首次连接中)') : ''}`);
      });
      break;

    case 'kick':
      if (args.length < 2) {
        log('用法: kick [username]', 'error');
        break;
      }

      const kickTargetName = args[1];
      const targetBot1 = bots.find(bot => bot.username === kickTargetName);

      if (targetBot1) {
        targetBot1.quit();
        log(`✅ 已踢出假人 ${kickTargetName}`, 'success');
      } else {
        log(`找不到名为 ${kickTargetName} 的假人`, 'error');
      }
      break;

    case 'restore':
      if (args.length < 2) {
        log('用法: restore [username]', 'error');
        break;
      }

      const restoreTargetName = args[1];
      if (!restoreTargetName) {
        log('用户名不能为空', 'error');
        break;
      }
      
      const targetBot = bots.find(bot => bot.username === restoreTargetName);

      if (targetBot) {
        targetBot.quit();
        setTimeout(() => {
          const isMainListener = bots.findIndex(b => b.username === targetBot.username) === 0;
          const newBot = createBot(targetBot.username, isMainListener, serverIP, serverPort);
          const index = bots.indexOf(targetBot);
          if (index !== -1) bots[index] = newBot;
          log(`已恢复假人 ${restoreTargetName}`, 'success');
        }, 1000);
      } else {
        log(`找不到名为 ${restoreTargetName} 的假人`, 'error');
      }
      break;

    case 'say':
      if (args.length < 2) {
        log('请提供要发送的消息内容。', 'error');
        break;
      }

      const messageArgs = args.slice(1);
      if (messageArgs.length === 1) {
        const message = messageArgs[0];
        bots.forEach(bot => {
          if (bot.isOnline) {
            bot.chat(message);
            log(`(全体) ${bot.username} 发送消息: ${message}`, 'info');
          }
        });
      } else {
        const targetName = messageArgs[0];
        const message = messageArgs.slice(1).join(' ');

        const targetBot = bots.find(bot => bot.username === targetName);
        if (targetBot && targetBot.isOnline) {
          targetBot.chat(message);
          log(`(指定) ${targetName} 发送消息: ${message}`, 'info');
        } else {
          log(`找不到名为 ${targetName} 的假人或其已离线`, 'error');
        }
      }
      break;
      
    case 'status':
      log(`当前状态: 
  维护模式: ${maintenanceMode ? colors.red('是') : colors.green('否')}
  假人服务运行中: ${botServiceRunning ? colors.green('是') : colors.red('否')}
  所有假人已连接: ${allBotsConnected ? colors.green('是') : colors.red('否')}
  活跃连接数: ${activeConnections}
  连接队列长度: ${connectionQueue.length}
  假人总数: ${bots.length}`, 'info');
      break;
      
    case 'help':
      log('可用命令:', 'info');
      log('  start [数量] [前缀] [服务器] - 启动自定义假人');
      log('  stop              - 停止假人服务或退出程序');
      log('  bots              - 列出所有假人状态');
      log('  kick [用户名]     - 踢出指定假人');
      log('  restore [用户名]  - 恢复指定假人');
      log('  say [消息]        - 让所有假人发送消息');
      log('  say [假人] [消息] - 让指定假人发送消息');
      log('  status            - 显示系统状态');
      log('  help              - 显示帮助');
      break;

    default:
      log('未知命令，输入 "help" 查看可用命令。', 'error');
  }
}

// 主函数
function main() {
  log("===== MineCraft Bot Tool =====", 'info');
  
  rl.on('line', (input) => {
    handleCommand(input);
    rl.prompt();
  }).on('close', () => {
    log('程序已关闭', 'info');
    process.exit(0);
  });
  
  rl.prompt();

  const hasStartupParams = process.argv.some(arg => 
    arg.startsWith('-s') || arg.startsWith('--server') || 
    arg.startsWith('-n') || arg.startsWith('--num') || 
    arg.startsWith('-f') || arg.startsWith('--prefix')
  );
  
  if (hasStartupParams) {
    log(`使用命令行参数: 服务器 ${defaultServerIP}:${defaultServerPort}`, 'info');
    startBots(bot_number, bot_prefix, defaultServerIP, defaultServerPort);
  } else {
    log("输入 'help' 查看可用命令", 'info');
  }
}

// 启动主程序
main();