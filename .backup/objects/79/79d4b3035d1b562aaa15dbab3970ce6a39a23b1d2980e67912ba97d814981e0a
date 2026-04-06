// 现实世界等高线地形图颜色表 (从平原到高山)
const terrainColors = [
    { limit: 0.10, r: 168, g: 224, b: 153 }, // 低海拔平原 (亮绿)
    { limit: 0.30, r: 199, g: 231, b: 163 }, // 丘陵 (黄绿)
    { limit: 0.50, r: 238, g: 229, b: 172 }, // 高地 (浅黄)
    { limit: 0.65, r: 230, g: 202, b: 147 }, // 浅山 (橘黄)
    { limit: 0.80, r: 204, g: 167, b: 122 }, // 中山 (浅褐)
    { limit: 0.90, r: 173, g: 133, b: 104 }, // 高山 (深褐)
    { limit: 1.00, r: 245, g: 245, b: 245 }  // 极高山/雪线 (白色)
];

const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
// 使用标准世界地图 2:1 比例的高清分辨率
const width = 1600; const height = 800;
canvas.width = width; canvas.height = height;

// 离屏 Canvas，用于保留原始 3D 贴图无损数据
const textureCanvas = document.createElement('canvas');
textureCanvas.width = width; textureCanvas.height = height;
const tCtx = textureCanvas.getContext('2d');

const generator = new MapGenerator(width, height);

function draw() {
    let imgData = tCtx.createImageData(width, height);
    let data = imgData.data;
    let viewMode = document.getElementById('viewMode').value;

    for (let i = 0; i < generator.cells.length; i++) {
        let c = generator.cells[i];
        let r, g, b;

        // 海洋与陆地基于海拔赋予标准出版颜色
            if (c.e < generator.seaLevel) {
                // 标准出版地图的浅蓝色海洋，越深越蓝
                // 使用动态的海平面阈值来计算深度占比
                let depth = (generator.seaLevel - c.e) / Math.max(0.01, generator.seaLevel);
                depth = Math.max(0, Math.min(1.0, depth)); // 防止 depth 越界变成黑色虚空
                // 浅海：216, 240, 250 -> 深海：160, 210, 240
                r = 216 - depth * 56;
                g = 240 - depth * 30;
                b = 250 - depth * 10;
            } else {
            // 计算陆地相对海拔 0.0 ~ 1.0
            let landE = (c.e - generator.seaLevel) / (1.0 - generator.seaLevel);
            // 查找等高线颜色
            for (let tc of terrainColors) {
                if (landE <= tc.limit) { r = tc.r; g = tc.g; b = tc.b; break; }
            }
            if (r === undefined) { r = 245; g = 245; b = 245; } // 超出部分为白
            
            let cx = i % width;
            let cy = Math.floor(i / width);
            
            // 计算纬度，Y 轴在 0 到 800 之间，中心 400 为赤道
            // cy / height 范围为 0.0 ~ 1.0，距离两极的距离决定冰盖
            let normalizedY = cy / height;
            // 距离最近一极的距离，0 表示极点，0.5 表示赤道
            let distToPole = Math.min(normalizedY, 1.0 - normalizedY);
            
            // 如果距离极点非常近，直接覆盖为白色（模拟极地冰盖）
            if (distToPole < 0.12) {
                r = 245; g = 245; b = 250;
            } else if (distToPole < 0.18) {
                // 极地过渡带，混合白色和原地形色
                let t = (distToPole - 0.12) / 0.06; // 0 (极点侧) 到 1 (温暖侧)
                r = 245 * (1 - t) + r * t;
                g = 245 * (1 - t) + g * t;
                b = 250 * (1 - t) + b * t;
            }
            
            // 等高线和地形光照

            if (viewMode === 'contour') {
                // 等高线模式：关闭阴影，绘制等高线条纹
                if (cx > 0 && cy > 0) {
                    let leftE = generator.cells[i - 1].e;
                    let topE = generator.cells[i - width].e;
                    let leftLandE = (leftE - generator.seaLevel) / (1.0 - generator.seaLevel);
                    let topLandE = (topE - generator.seaLevel) / (1.0 - generator.seaLevel);
                    
                    // 判断是否有海拔等级的跨越，绘制深色线条
                    for (let tc of terrainColors) {
                        if ((landE <= tc.limit && leftLandE > tc.limit) || (landE <= tc.limit && topLandE > tc.limit) ||
                            (landE > tc.limit && leftLandE <= tc.limit) || (landE > tc.limit && topLandE <= tc.limit)) {
                            r = 100; g = 100; b = 100; // 等高线颜色
                            break;
                        }
                    }
                }
            } else {
                // 地形浮雕光照 (Hillshading)
                if (cx > 0 && cy > 0) {
                    let leftE = generator.cells[i - 1].e;
                    let topE = generator.cells[i - width].e;
                    let dx = c.e - leftE;
                    let dy = c.e - topE;
                    // 温和的光影对比度，体现出细腻的地形
                    let shade = (dx + dy) * 12; 
                    let lightMod = 1.0 + shade;
                    
                    // 限制光照范围：防止高山悬崖处的背光面阴影变成死黑
                    lightMod = Math.max(0.4, Math.min(1.8, lightMod));
                    
                    r = Math.min(255, r * lightMod);
                    g = Math.min(255, g * lightMod);
                    b = Math.min(255, b * lightMod);
                }
            }
        }

        // 渲染水系 (湖泊和河流)
        if (c.e >= generator.seaLevel) {
            if (c.isLake) {
                // 湖泊颜色：非常显眼的亮蓝色，确保能在复杂地形中看清
                r = 90; g = 170; b = 240;
            }
        }

        // 国家颜色与标准出版图边界渲染
        if (c.nation !== -1 && c.e >= generator.seaLevel && viewMode !== 'pure_terrain' && viewMode !== 'contour' && !c.isLake) {
            let nColor = generator.nations[c.nation].rgb;
            
            if (viewMode === 'political') {
                // 政区图模式：完全使用柔和明亮的国家颜色，保留极轻微地形阴影
                r = r * 0.15 + nColor.r * 0.85;
                g = g * 0.15 + nColor.g * 0.85;
                b = b * 0.15 + nColor.b * 0.85;
                
                // 细致清爽的边界线（深灰/深紫色调，非死黑）
                if (c.border) { r = 90; g = 70; b = 110; }
            } else {
                // 地形混合模式：主要展现地形颜色，边界使用紫色半透明风格以模仿现实国界标绘
                r = r * 0.90 + nColor.r * 0.10; // 极少量的国家颜色
                g = g * 0.90 + nColor.g * 0.10;
                b = b * 0.90 + nColor.b * 0.10;
                
                // 地势图上标准的紫色国界线，且周边轻微泛紫作为领土光晕
                if (c.border) { 
                    r = 138; g = 43; b = 226; // 蓝紫色边境线
                }
            }
        }

        data[i*4] = r; data[i*4+1] = g; data[i*4+2] = b; data[i*4+3] = 255;
    }
    tCtx.putImageData(imgData, 0, 0);

    // 矢量抗锯齿绘制极其柔和的河流
    if (generator.rivers && viewMode !== 'contour') {
        for (let river of generator.rivers) {
            for (let i = 0; i < river.length - 1; i++) {
                let p1 = river[i];
                let p2 = river[i+1];
                
                // 防止在球体接缝处出现横穿整张图的连线
                if (Math.abs(p1.x - p2.x) > width / 2) continue; 
                
                let flowStr = Math.min(1.0, i / 100);
                // 河流从源头的 1px 细丝，柔和平滑地过渡到入海口的宽度
                tCtx.lineWidth = 1.0 + i * 0.04; 
                
                // 颜色从浅青色到深青蓝自然渐变
                let rC = Math.floor(150 - flowStr * 60);
                let gC = Math.floor(210 - flowStr * 30);
                let bC = Math.floor(255 - flowStr * 10);
                
                tCtx.strokeStyle = `rgba(${rC}, ${gC}, ${bC}, 0.9)`;
                // 开启原生线条圆角抗锯齿
                tCtx.lineCap = 'round';
                tCtx.lineJoin = 'round';
                
                tCtx.beginPath();
                tCtx.moveTo(p1.x, p1.y);
                tCtx.lineTo(p2.x, p2.y);
                tCtx.stroke();
            }
        }
    }


    // 绘制经纬网
    if (document.getElementById('showGrid').checked) {
        tCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        tCtx.lineWidth = 1;
        tCtx.beginPath();
        // 纬线（每 30 度一条，即 800 高度分 6 份，每份 133.33px）
        for (let i = 1; i < 6; i++) {
            let y = (height / 6) * i;
            tCtx.moveTo(0, y);
            tCtx.lineTo(width, y);
        }
        // 赤道加粗或换色以示区分
        tCtx.stroke();
        tCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        tCtx.beginPath();
        tCtx.moveTo(0, height / 2);
        tCtx.lineTo(width, height / 2);
        tCtx.stroke();

        tCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        tCtx.beginPath();
        // 经线（每 30 度一条，即 1600 宽度分 12 份，每份 133.33px）
        for (let i = 1; i < 12; i++) {
            let x = (width / 12) * i;
            tCtx.moveTo(x, 0);
            tCtx.lineTo(x, height);
        }
        tCtx.stroke();
    }

    // 绘制首都 (纯地形和等高线模式下不显示首都)
    if (viewMode !== 'pure_terrain' && viewMode !== 'contour') {
        for (let n of generator.nations) {
            // 如果首都在地图边缘附近，需要同时在另一侧绘制一个镜像，以防在 3D 球体接缝处穿帮
            let drawCapital = (x, y) => {
                tCtx.fillStyle = n.color;
                tCtx.strokeStyle = '#fff';
                tCtx.lineWidth = 1.5;
                tCtx.beginPath();
                tCtx.arc(x, y, 5, 0, Math.PI * 2);
                tCtx.fill(); tCtx.stroke();
                
                tCtx.fillStyle = '#000';
                tCtx.beginPath();
                tCtx.arc(x, y, 2, 0, Math.PI * 2);
                tCtx.fill();
            };

            drawCapital(n.capital.x, n.capital.y);
            // 边缘镜像处理
            if (n.capital.x < 10) drawCapital(n.capital.x + width, n.capital.y);
            if (n.capital.x > width - 10) drawCapital(n.capital.x - width, n.capital.y);
        }
    }

    // --- 更新 3D 地球贴图并直接将结果复制回主 Canvas ---
    if (typeof globe !== 'undefined' && globe) {
        globe.material.map = new THREE.CanvasTexture(textureCanvas);
        globe.material.map.needsUpdate = true;
    }
    
    // 直接将无损的长方形 2D 地图画到可见的主画布上
    ctx.drawImage(textureCanvas, 0, 0);
}
function updateLegend() {
    const legend = document.getElementById('legend');
    legend.innerHTML = '<h3>标准等高线地形图例</h3>';
    
    // 海洋图例
    legend.innerHTML += `<div class="legend-item"><div class="color-box" style="background-color: rgb(160,210,240)"></div><span>深海</span></div>`;
    legend.innerHTML += `<div class="legend-item"><div class="color-box" style="background-color: rgb(216,240,250)"></div><span>浅海</span></div>`;
    
    // 陆地图例
    const names = ['平原', '丘陵', '高地', '浅山', '中山', '高山', '雪线'];
    for (let i = 0; i < terrainColors.length; i++) {
        let tc = terrainColors[i];
        legend.innerHTML += `<div class="legend-item">
            <div class="color-box" style="background-color: rgb(${tc.r},${tc.g},${tc.b})"></div>
            <span>${names[i]}</span>
        </div>`;
    }
}

document.getElementById('generateBtn').addEventListener('click', () => {
    document.getElementById('generateBtn').innerText = "生成中...";
    // 使用 setTimeout 使 UI 能够先刷新文字
    setTimeout(() => {
        const nationCount = parseInt(document.getElementById('nationCount').value);
        const seaLevel = parseInt(document.getElementById('seaLevel').value) / 100;
        
        generator.generate({ nationCount, seaLevel });
        updateNationSelect();
        draw();
        
        document.getElementById('generateBtn').innerText = "生成新地图";
    }, 50);
});

document.getElementById('viewMode').addEventListener('change', draw);
document.getElementById('showGrid').addEventListener('change', draw);

// 绑定导出高清图片逻辑 (兼容移动端的长按保存)
document.getElementById('exportBtn').addEventListener('click', () => {
    // 创建一个包含图例的新 Canvas 用于导出
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ectx = exportCanvas.getContext('2d');
    
    // 绘制原地图
    ectx.drawImage(canvas, 0, 0);
    
    // 绘制图例
    const viewMode = document.getElementById('viewMode').value;
    
    // 图例背景框
    ectx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ectx.shadowColor = 'rgba(0,0,0,0.3)';
    ectx.shadowBlur = 10;
    // 加高背景框并整体向上移动，防止底部颜色（深海）溢出容器
    ectx.fillRect(20, exportCanvas.height - 330, 210, 310);
    ectx.shadowBlur = 0; // 重置阴影
    
    // 图例标题
    ectx.fillStyle = '#333';
    ectx.font = 'bold 20px sans-serif';
    ectx.textAlign = 'left';
    let title = "标准等高线地形图例";
    if (viewMode === 'political') title = "世界政治版图图例";
    if (viewMode === 'pure_terrain') title = "大陆地形图例";
    if (viewMode === 'contour') title = "标准测绘等高线图例";
    ectx.fillText(title, 35, exportCanvas.height - 295);
    
    // 绘制等高线颜色标尺 (从高到低)
    ectx.font = '16px sans-serif';
    const names = ['平原', '丘陵', '高地', '浅山', '中山', '高山', '雪线'];
    
    let yOffset = exportCanvas.height - 260;
    
    // 倒序绘制地形图例
    for (let i = terrainColors.length - 1; i >= 0; i--) {
        let tc = terrainColors[i];
        ectx.fillStyle = `rgb(${tc.r},${tc.g},${tc.b})`;
        ectx.fillRect(35, yOffset, 25, 18);
        ectx.fillStyle = '#333';
        ectx.fillText(names[i], 70, yOffset + 14);
        yOffset += 25;
    }
    
    // 海洋图例
    yOffset += 5;
    ectx.fillStyle = 'rgb(216,240,250)';
    ectx.fillRect(35, yOffset, 25, 18);
    ectx.fillStyle = '#333';
    ectx.fillText('浅海', 70, yOffset + 14);
    
    yOffset += 25;
    ectx.fillStyle = 'rgb(160,210,240)';
    ectx.fillRect(35, yOffset, 25, 18);
    ectx.fillStyle = '#333';
    ectx.fillText('深海', 70, yOffset + 14);

    const dataURL = exportCanvas.toDataURL('image/png');
    document.getElementById('exportedImg').src = dataURL;
    document.getElementById('exportModal').style.display = 'block';
});

document.getElementById('closeModal').addEventListener('click', () => {
    document.getElementById('exportModal').style.display = 'none';
});

// 全屏和强制横屏 (在用户交互时触发)
document.getElementById('map-container').addEventListener('click', () => {
    let elem = document.documentElement;
    if (elem.requestFullscreen) {
        elem.requestFullscreen().then(() => {
            if (screen.orientation && screen.orientation.lock) {
                screen.orientation.lock("landscape").catch(err => console.log(err));
            }
        }).catch(err => console.log(err));
    }
});

updateLegend();
document.getElementById('generateBtn').click();

// ======================= 3D 球体视图逻辑 =======================
let is3DMode = false;
let scene, camera, renderer, globe, controls;
let animationFrameId;

function init3D() {
    const container = document.getElementById('map-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // 创建场景
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050505); // 宇宙深邃的背景色

    // 创建相机
    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.z = 3; // 相机距离

    // 创建渲染器
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.domElement.id = 'threeCanvas';
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.top = '0';
    renderer.domElement.style.left = '0';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    // 创建球体模型 (分段越多越圆滑)
    const geometry = new THREE.SphereGeometry(1, 64, 64);
    
    // 关键：将 2D 画布作为纹理贴图！
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy(); // 提高纹理清晰度
    // 基础材质，不需要光照，直接显示贴图颜色
    const material = new THREE.MeshBasicMaterial({ map: texture });
    
    globe = new THREE.Mesh(geometry, material);
    
    // 因为 THREE.js 默认将纹理贴上去后，东西半球可能是反的或镜像的，
    // 这里我们翻转一下 X 轴的缩放比例来修正映射
    globe.scale.x = -1;
    
    scene.add(globe);

    // 轨道控制器 (支持拖拽旋转，滚轮/双指缩放)
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enablePan = false; // 禁止平移，只能旋转地球
    controls.minDistance = 1.2; // 限制缩放级别，不能钻进地球内部
    controls.maxDistance = 6.0;

    container.appendChild(renderer.domElement);

    // 窗口大小变化自适应
    window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
    if (!is3DMode) return;
    const container = document.getElementById('map-container');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}

function animate3D() {
    animationFrameId = requestAnimationFrame(animate3D);
    controls.update(); // 必须在动画循环中调用以支持惯性滑动
    
    // 如果想要地球自己缓慢自转，取消下面这行的注释即可：
    // globe.rotation.y += 0.0005;
    
    renderer.render(scene, camera);
}

document.getElementById('toggle3DBtn').addEventListener('click', () => {
    const btn = document.getElementById('toggle3DBtn');
    const container = document.getElementById('map-container');
    
    if (!is3DMode) {
        // 进入 3D 模式
        is3DMode = true;
        btn.innerText = "返回 2D 视图";
        btn.style.backgroundColor = "#e74c3c"; // 变红色
        
        // 隐藏原本的 2D Canvas
        canvas.style.display = 'none';
        
        // 如果是第一次进入，初始化环境；否则直接更新贴图
        if (!scene) {
            init3D();
        } else {
            // 当用户在 2D 下修改了模式（比如换成了政区图）后再切回 3D
            // 需要强制更新材质的纹理贴图
            globe.material.map = new THREE.CanvasTexture(textureCanvas);
            globe.material.map.needsUpdate = true;
            renderer.domElement.style.display = 'block';
        }
        
        animate3D();
    } else {
        // 返回 2D 模式
        is3DMode = false;
        btn.innerText = "进入 3D 视图";
        btn.style.backgroundColor = "#3498db"; // 变蓝色
        
        // 停止动画循环以节省性能
        cancelAnimationFrame(animationFrameId);
        
        // 隐藏 3D 画布，显示 2D 画布
        renderer.domElement.style.display = 'none';
        canvas.style.display = 'block';
    }
});



// ======================= 编辑与导入导出逻辑 =======================

function updateNationSelect() {
    const brushNation = document.getElementById('brushNation');
    if (!brushNation) return;
    brushNation.innerHTML = '<option value="-1">移除领土 (变成无主地)</option>';
    if(generator.nations) {
        generator.nations.forEach(n => {
            brushNation.innerHTML += `<option value="${n.id}">国家 ${n.id} (${n.color})</option>`;
        });
    }
}

document.getElementById('editMode').addEventListener('change', (e) => {
    document.getElementById('editControls').style.display = e.target.checked ? 'block' : 'none';
});

document.getElementById('editTool').addEventListener('change', (e) => {
    let tool = e.target.value;
    document.getElementById('nationSelectControl').style.display = tool === 'nation' ? 'block' : 'none';
    document.getElementById('brushSizeControl').style.display = (tool === 'raise' || tool === 'lower' || tool === 'nation') ? 'block' : 'none';
    document.getElementById('lassoControls').style.display = tool === 'lasso' ? 'block' : 'none';
    
    // 如果选择了建城模式，隐藏画笔强度
    let isCity = tool === 'city';
    document.getElementById('brushStrength').parentElement.style.display = isCity || tool === 'lasso' ? 'none' : 'block';
    
    // 如果切出了圈选工具，清空选区
    if (tool !== 'lasso') {
        lassoPoints = [];
        draw();
    }
});

// 初始化城市生成器及模态框事件
window.addEventListener('DOMContentLoaded', () => {
    window.cityGen = new CityGenerator('cityCanvas');

    // 绑定独立建城按钮
    document.getElementById('btnDirectCity').addEventListener('click', () => {
        // 自动勾选“开启画笔编辑”
        let editCheckbox = document.getElementById('editMode');
        if (!editCheckbox.checked) {
            editCheckbox.click();
        }
        
        // 由于我们将 editTool 的 city 删除了，我们用一个全局状态标识进入独立建城模式
        window.isDirectCityMode = true;
        
        // 变色提示
        const btn = document.getElementById('btnDirectCity');
        const oldText = '🏙️ 快速建立城市';
        btn.style.background = '#e74c3c';
        btn.innerText = '请在地图上点击...';
        
        // 鼠标变十字
        document.getElementById('mapCanvas').style.cursor = 'crosshair';
        
        // 5秒后自动重置状态
        if (window.cityTimeout) clearTimeout(window.cityTimeout);
        window.cityTimeout = setTimeout(() => {
            if (window.isDirectCityMode) {
                btn.style.background = '#9b59b6';
                btn.innerText = oldText;
                window.isDirectCityMode = false;
                document.getElementById('mapCanvas').style.cursor = 'default';
            }
        }, 5000);
    });

    document.getElementById('closeCityModal').addEventListener('click', () => {
        document.getElementById('cityModal').style.display = 'none';
    });
    
    document.getElementById('btnRegenerateCity').addEventListener('click', () => {
        if (!window.lastCityPos) return;

        cityGen.updateParams({
            seaLevel: parseFloat(document.getElementById('citySeaLevel').value),
            comZone: parseFloat(document.getElementById('cityComZone').value),
            roadDensity: parseInt(document.getElementById('cityRoadDens').value)
        });

        cityGen.generate(window.lastCityPos.x, window.lastCityPos.y);
    });

    document.getElementById('btnDownloadCity').addEventListener('click', () => {
        const cityCanvas = document.getElementById('cityCanvas');
        const link = document.createElement('a');
        link.download = `city_map_${Date.now()}.png`;
        link.href = cityCanvas.toDataURL('image/png');
        link.click();
    });

    document.querySelectorAll('input[name="cityViewMode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (!window.lastCityPos) return; // 还没生成
            let mode = e.target.value;
            // TODO: 在 cityGen 中实现视图切换，目前全按 renderFinal 处理
            cityGen.renderFinal();
        });
    });
});

// 射线法判断点是否在多边形内部
function isPointInPolygon(point, vs) {
    let x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].x, yi = vs[i].y;
        let xj = vs[j].x, yj = vs[j].y;
        let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// 提取当前圈选的全部 Cell 集合
function getCellsInLasso() {
    let cellsInLasso = [];
    if (lassoPoints.length < 3) return cellsInLasso;
    
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let p of lassoPoints) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
    }
    
    for (let y = Math.max(0, minY); y <= Math.min(height-1, maxY); y++) {
        for (let x = Math.max(0, minX); x <= Math.min(width-1, maxX); x++) {
            if (isPointInPolygon([x, y], lassoPoints)) {
                cellsInLasso.push(generator.cells[generator.idx(x, y)]);
            }
        }
    }
    return cellsInLasso;
}

// 执行 Lasso 操作
function executeLassoAction(actionType) {
    let cells = getCellsInLasso();
    if (cells.length === 0) return;

    const strength = parseFloat(document.getElementById('brushStrength').value);

    // 1. 计算拓扑距离场（终极修复：线段最短投影距离）
    // 之前只计算了到顶点的距离，导致由于鼠标事件稀疏，圈出的是直棱直角的多边形！
    let maxDist = 0.001;
    cells.forEach(c => {
        let minDistSq = Infinity;
        for (let i = 0; i < lassoPoints.length; i++) {
            let p = lassoPoints[i];
            let q = lassoPoints[(i + 1) % lassoPoints.length];
            
            let px = p.x, py = p.y;
            let qx = q.x, qy = q.y;
            
            // 处理横跨地图边界的线段
            if (Math.abs(qx - px) > width / 2) {
                if (qx < px) qx += width;
                else px += width;
            }
            
            let cx = c.x;
            // 测试原始与跨界的点距，保证边缘计算准确无误
            for (let offset of [0, width, -width]) {
                let wcx = cx + offset;
                let l2 = (qx - px)*(qx - px) + (qy - py)*(qy - py);
                let dSq;
                if (l2 === 0) {
                    dSq = (wcx - px)*(wcx - px) + (c.y - py)*(c.y - py);
                } else {
                    // 线段最短投影法 (Point-to-Segment Projection)
                    let t = ((wcx - px)*(qx - px) + (c.y - py)*(qy - py)) / l2;
                    t = Math.max(0, Math.min(1, t));
                    let projX = px + t * (qx - px);
                    let projY = py + t * (qy - py);
                    dSq = (wcx - projX)*(wcx - projX) + (c.y - projY)*(c.y - projY);
                }
                if (dSq < minDistSq) minDistSq = dSq;
            }
        }
        c.distToEdge = Math.sqrt(minDistSq);
        if (c.distToEdge > maxDist) maxDist = c.distToEdge;
    });

    let p1 = Math.random() * 1000;
    let p2 = Math.random() * 1000;

    cells.forEach(c => {
        let nx = c.x / width, ny = c.y / height;
        let originalE = c.e;
        
        // 【终结多边形：距离场域扭曲 (Domain Warping)】
        // 为什么之前是多边形？因为你的选区边缘是直线的。
        // 现在我们通过全局无缝噪声对“距离”进行扭曲，让直线的边缘变成自然的狗牙交错的海岸线！
        let warpNoise = generator.noiseSeamless(nx, ny, 15, 4, 0.5, 2, p1) * 2.0 - 1.0; 
        // 允许最多 40% 的边界畸变，彻底打碎直棱直角
        let warpedDist = c.distToEdge + warpNoise * (maxDist * 0.4); 
        
        let t = warpedDist / maxDist;
        t = Math.max(0, Math.min(1, t));
        
        // 完美五次平滑蒙版
        let mask = t * t * t * (t * (t * 6 - 15) + 10); 
        
        let targetE = originalE;

        if (actionType === 'raise') {
            targetE = originalE + strength;
        } else if (actionType === 'lower') {
            targetE = originalE - strength;
        } else if (actionType === 'random') {
            // 提升起伏感，增加频率和强度，打破“扁平”感
            let n = generator.noiseSeamless(nx, ny, 30, 8, 0.55, 2, p1);
            n = Math.max(-1.0, Math.min(1.0, n)); 
            targetE = originalE + n * strength;
        } else if (actionType === 'mountain') {
            // 解开封印：狂野、高频、宏伟的分形山脊
            // 增加基础频率，并将层数 octaves 增加到 8 提升尖锐细节
            let n = generator.noiseSeamless(nx, ny, 40, 8, 0.55, 2, p2);
            let clampedN = Math.max(0.0, Math.min(1.0, (n + 1.0) / 2.0));
            
            let ridge = 1.0 - Math.abs(clampedN * 2.0 - 1.0);
            // 降低幂次，让山峰更加宽厚雄伟，不再被过度压缩成扁包
            ridge = Math.pow(ridge, 1.2); 
            
            // 将基础高度加上，同时乘以极大的 strength 乘数，让山脉真正拔地而起
            let mountainHeight = ridge * strength * 1.5;
            targetE = originalE + mountainHeight;
        }

        let finalE = originalE * (1 - mask) + targetE * mask;
        
        // 最后还要加一道最坚固的安全锁，确保写入的地形海拔永远不出现非法数值
        if (isNaN(finalE)) finalE = originalE;
        c.e = Math.max(0.0, Math.min(1.0, finalE));
        if (c.e > generator.seaLevel && originalE <= generator.seaLevel) {
            c.isLake = false;
        }
    });

    lassoPoints = [];
    draw();
}

document.getElementById('btnLassoRaise').addEventListener('click', () => executeLassoAction('raise'));
document.getElementById('btnLassoLower').addEventListener('click', () => executeLassoAction('lower'));
document.getElementById('btnLassoRandom').addEventListener('click', () => executeLassoAction('random'));
document.getElementById('btnLassoMountain').addEventListener('click', () => executeLassoAction('mountain'));
document.getElementById('btnLassoClear').addEventListener('click', () => { lassoPoints = []; draw(); });

document.getElementById('exportDataBtn').addEventListener('click', () => {
    const data = generator.exportData();
    const jsonStr = JSON.stringify(data);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "fantasy_map_data.json";
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('importDataBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
});

document.getElementById('importFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target.result);
            generator.importData(data);
            updateNationSelect();
            draw();
            alert("地图导入成功！");
        } catch (err) {
            alert("导入失败：文件格式错误");
            console.error(err);
        }
    };
    reader.readAsText(file);
});

// ======================= 画笔交互逻辑 =======================
let isPainting = false;
let lassoPoints = []; // 储存选区多边形的点
let lastPaintTime = 0;

function getMousePos(canvas, evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    // 支持移动端触摸
    let clientX = evt.clientX;
    let clientY = evt.clientY;
    if (evt.touches && evt.touches.length > 0) {
        clientX = evt.touches[0].clientX;
        clientY = evt.touches[0].clientY;
    }
    return {
        x: Math.floor((clientX - rect.left) * scaleX),
        y: Math.floor((clientY - rect.top) * scaleY)
    };
}

let lastMousePos = null;

function handleStart(e) {
    if (is3DMode) return;
    lastMousePos = getMousePos(canvas, e);
    
    let currentTool = document.getElementById('editTool') ? document.getElementById('editTool').value : null;
    
    // 如果是独立建城模式，则弹窗并演算，不进行绘画
    if (window.isDirectCityMode) {
        isPainting = false;
        window.isDirectCityMode = false; // 消费掉这次点击
        
        // 恢复按钮状态
        const btn = document.getElementById('btnDirectCity');
        btn.style.background = '#9b59b6';
        btn.innerText = '🏙️ 快速建立城市';
        document.getElementById('mapCanvas').style.cursor = 'default';
        
        document.getElementById('cityModal').style.display = 'flex';
        // 记录点击在大地图上的百分比坐标，传给城市生成器作为局部高频采样的基准
        window.lastCityPos = {
            x: lastMousePos.x / width,
            y: lastMousePos.y / height
        };
        // 读取主地图海平面初始值
        document.getElementById('citySeaLevel').value = generator.seaLevel;
        // 修复部分设备可能出现的渲染卡顿，稍微延时执行渲染
        setTimeout(() => {
            document.getElementById('btnRegenerateCity').click();
        }, 100);
        return;
    }
    
    if (!document.getElementById('editMode').checked) return;
    isPainting = true;
    if (currentTool === 'lasso') {
        lassoPoints = [lastMousePos];
        drawLassoOverlay();
    } else {
        applyPaintLine(lastMousePos, lastMousePos);
    }
}

let paintTicking = false;
let lastPaintEvent = null;

function handleMove(e) {
    let currentTool = document.getElementById('editTool').value;
    if (isPainting && currentTool !== 'city') {
        lastPaintEvent = e;
        if (!paintTicking) {
            requestAnimationFrame(() => {
                if (lastPaintEvent) {
                    let currentPos = getMousePos(canvas, lastPaintEvent);
                    if (currentTool === 'lasso') {
                        lassoPoints.push(currentPos);
                        drawLassoOverlay();
                    } else {
                        applyPaintLine(lastMousePos, currentPos);
                        lastMousePos = currentPos;
                    }
                }
                paintTicking = false;
            });
            paintTicking = true;
        }
    }
}

function drawLassoOverlay() {
    draw(); // 清空旧的叠加层，重新画底图
    if (lassoPoints.length < 2) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
        ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    // 闭合
    ctx.lineTo(lassoPoints[0].x, lassoPoints[0].y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 0, 0, 0.15)';
    ctx.fill();
    ctx.restore();
}

function handleEnd() {
    if (isPainting) {
        isPainting = false;
        // 如果是画笔模式，抬起时才全局更新恢复河流。如果是圈选模式，保留红色线框
        if (document.getElementById('editTool').value !== 'lasso') {
            draw(); 
        } else {
            drawLassoOverlay();
        }
    }
}

canvas.addEventListener('mousedown', handleStart);
canvas.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);

// 移动端触摸防抖处理
canvas.addEventListener('touchstart', (e) => { 
    if (document.getElementById('editMode').checked && !is3DMode) e.preventDefault(); 
    handleStart(e); 
}, {passive: false});
canvas.addEventListener('touchmove', (e) => { 
    if (document.getElementById('editMode').checked && !is3DMode) e.preventDefault(); 
    handleMove(e); 
}, {passive: false});
window.addEventListener('touchend', handleEnd);

function applyPaintLine(startPos, endPos) {
    const tool = document.getElementById('editTool').value;
    const brushSize = parseInt(document.getElementById('brushSize').value);
    const brushStrength = parseFloat(document.getElementById('brushStrength').value);
    const selectedNation = parseInt(document.getElementById('brushNation').value);
    
    let changedCells = [];
    let checkedMap = new Set();
    
    let dx = endPos.x - startPos.x;
    if (dx > width / 2) dx -= width;
    if (dx < -width / 2) dx += width;
    let dy = endPos.y - startPos.y;
    let dist = Math.sqrt(dx*dx + dy*dy);
    
    // 减小插值密度以提升性能，配合分形笔刷填充空隙
    let step = Math.max(2, brushSize * 0.4);
    let stepsCount = Math.max(1, Math.ceil(dist / step));
    
    for (let i = 0; i <= stepsCount; i++) {
        let t = stepsCount === 0 ? 0 : i / stepsCount;
        let cx = Math.round(startPos.x + dx * t);
        let cy = Math.round(startPos.y + dy * t);
        
        // 分形扰动散布范围
        let scatterRadius = brushSize * 1.5; 
        
        for (let bdy = -scatterRadius; bdy <= scatterRadius; bdy++) {
            for (let bdx = -scatterRadius; bdx <= scatterRadius; bdx++) {
                let distSq = bdx*bdx + bdy*bdy;
                // 用噪声来侵蚀圆形笔刷边界，形成极度不规则的自然海岸线与陆地块
                let nx = cx + bdx;
                let ny = cy + bdy;
                
                // 复合分形噪声（Fractal Noise Erosion）
                let noise1 = Math.sin(nx * 0.1) * Math.cos(ny * 0.1);
                let noise2 = Math.sin(nx * 0.03 + 2.0) * Math.cos(ny * 0.03 + 1.0);
                let fractalErosion = (noise1 * 0.4 + noise2 * 0.6) * scatterRadius; 
                
                let dynamicBrushSq = (brushSize + fractalErosion);
                dynamicBrushSq *= dynamicBrushSq;
                
                if (distSq <= dynamicBrushSq) {
                    if (nx < 0) nx += width;
                    if (nx >= width) nx -= width;
                    if (ny >= 0 && ny < height) {
                        let idx = generator.idx(nx, ny);
                        if (checkedMap.has(idx)) continue;
                        checkedMap.add(idx);
                        
                        let c = generator.cells[idx];
                        
                        let distRatio = Math.sqrt(distSq) / Math.max(1, (brushSize + fractalErosion));
                        let falloff = Math.max(0, 1.0 - distRatio);
                        
                        // 随机化高度，自动生成高低起伏的山峰和山脊
                        let heightVariability = Math.sin(nx * 0.2 + ny * 0.2) * 0.5 + 0.5; 
                        let finalStrength = brushStrength * falloff * (0.5 + heightVariability * 0.5);
                        
                        let modified = false;
                        if (tool === 'raise') {
                            c.e = Math.min(1.0, c.e + finalStrength);
                            if (c.e > generator.seaLevel) c.isLake = false; 
                            modified = true;
                        } else if (tool === 'lower') {
                            c.e = Math.max(0.0, c.e - finalStrength);
                            modified = true;
                        } else if (tool === 'nation') {
                            // 只有核心区域才会染色
                            if (falloff > 0.4 && c.e >= generator.seaLevel && !c.isLake && c.nation !== selectedNation) {
                                c.nation = selectedNation;
                                modified = true;
                            }
                        }
                        if (modified) changedCells.push(c);
                    }
                }
            }
        }
    }

    if (changedCells.length > 0) {
        // 性能保护：如果单次改动的像素太多（拉了很长一笔），局部扩散搜索边界的 O(N^2) 耗时会引发卡顿
        // 此时直接回退到全局批处理渲染 draw() 反而速度更快，并能彻底消除撕裂感
        if (changedCells.length > 1500) {
            draw();
            return;
        }

        // 极速重算被修改区域的边界并直接执行局部渲染
        let dirs = [[0,1],[1,0],[0,-1],[-1,0]];
        let checkedIdx = new Set();
        let viewMode = document.getElementById('viewMode').value;
        
        // 提取底层的图像数据用于局部更新（以单个像素宽高创建性能极高的独立写入缓冲区）
        for (let bc of changedCells) {
            let coordsToCheck = [[bc.x, bc.y]];
            for(let d of dirs) {
                let nx = bc.x + d[0], ny = bc.y + d[1];
                if (nx < 0) nx += width;
                if (nx >= width) nx -= width;
                if (ny >= 0 && ny < height) coordsToCheck.push([nx, ny]);
            }
            
            for (let coord of coordsToCheck) {
                let cx = coord[0], cy = coord[1];
                let idx = generator.idx(cx, cy);
                if (checkedIdx.has(idx)) continue;
                checkedIdx.add(idx);
                
                let c = generator.cells[idx];
                if (c.e >= generator.seaLevel && c.nation !== -1) {
                    let isBorder = false;
                    for (let d of dirs) {
                        let nnx = cx + d[0], nny = cy + d[1];
                        if (nny < 0 || nny >= height) continue;
                        if (nnx < 0) nnx += width;
                        if (nnx >= width) nnx -= width;
                        let nnc = generator.cells[generator.idx(nnx, nny)];
                        if (nnc.e >= generator.seaLevel && nnc.nation !== -1 && nnc.nation !== c.nation) {
                            isBorder = true; break;
                        }
                    }
                    c.border = isBorder;
                } else {
                    c.border = false;
                }

                // ==================== 局部高速渲染着色器 ====================
                let r, g, b;
                
                // 1. 基础海拔上色
                if (c.e < generator.seaLevel) {
                    let depth = (generator.seaLevel - c.e) / Math.max(0.01, generator.seaLevel);
                    depth = Math.max(0, Math.min(1.0, depth)); 
                    r = 216 - depth * 56;
                    g = 240 - depth * 30;
                    b = 250 - depth * 10;
                } else {
                    let landE = (c.e - generator.seaLevel) / (1.0 - generator.seaLevel);
                    for (let tc of terrainColors) {
                        if (landE <= tc.limit) { r = tc.r; g = tc.g; b = tc.b; break; }
                    }
                    if (r === undefined) { r = 245; g = 245; b = 245; }
                    
                    let normalizedY = cy / height;
                    let distToPole = Math.min(normalizedY, 1.0 - normalizedY);
                    if (distToPole < 0.12) {
                        r = 245; g = 245; b = 250;
                    } else if (distToPole < 0.18) {
                        let t = (distToPole - 0.12) / 0.06; 
                        r = 245 * (1 - t) + r * t;
                        g = 245 * (1 - t) + g * t;
                        b = 250 * (1 - t) + b * t;
                    }
                    
                    // 2. 地形浮雕光照
                    if (viewMode !== 'contour' && cx > 0 && cy > 0) {
                        let leftE = generator.cells[idx - 1].e;
                        let topE = generator.cells[idx - width].e;
                        let dxE = c.e - leftE;
                        let dyE = c.e - topE;
                        let lightMod = Math.max(0.4, Math.min(1.8, 1.0 + (dxE + dyE) * 12));
                        r = Math.min(255, r * lightMod);
                        g = Math.min(255, g * lightMod);
                        b = Math.min(255, b * lightMod);
                    }
                }
                
                // 3. 渲染湖泊
                if (c.e >= generator.seaLevel && c.isLake) {
                    r = 90; g = 170; b = 240;
                }
                
                // 4. 国家与边界混色
                if (c.nation !== -1 && c.e >= generator.seaLevel && viewMode !== 'pure_terrain' && viewMode !== 'contour' && !c.isLake) {
                    let nColor = generator.nations[c.nation].rgb;
                    if (viewMode === 'political') {
                        r = r * 0.15 + nColor.r * 0.85;
                        g = g * 0.15 + nColor.g * 0.85;
                        b = b * 0.15 + nColor.b * 0.85;
                        if (c.border) { r = 90; g = 70; b = 110; }
                    } else {
                        r = r * 0.90 + nColor.r * 0.10;
                        g = g * 0.90 + nColor.g * 0.10;
                        b = b * 0.90 + nColor.b * 0.10;
                        if (c.border) { r = 138; g = 43; b = 226; }
                    }
                }
                
                // 5. 立即更新这一个像素！(直接创建单像素 ImageData，无需重构整张图)
                let pixel = ctx.createImageData(1, 1);
                pixel.data[0] = r; pixel.data[1] = g; pixel.data[2] = b; pixel.data[3] = 255;
                // 将结果写回主画布与离屏 3D 画布，保证数据无损一致
                ctx.putImageData(pixel, cx, cy);
                tCtx.putImageData(pixel, cx, cy);
            }
        }
    }
}
