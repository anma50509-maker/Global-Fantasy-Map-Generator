/**
 * 城市程序化生成器
 * 按照管线：地形 -> 初始地价 -> 道路网 -> 可达性场 -> 最终地价 -> 区域划分 -> 渲染
 */

class CityGenerator {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        
        // 尺寸设定 (长方形高清分辨率)
        this.width = 1024;
        this.height = 640;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        let totalCells = this.width * this.height;
        
        // 生成数据缓存
        this.heightMap = new Float32Array(totalCells);
        this.waterMask = new Uint8Array(totalCells);
        this.pTerrain = new Float32Array(totalCells); // 初始地价
        this.roadNetwork = new Uint8Array(totalCells); // 道路
        this.rRoad = new Float32Array(totalCells); // 道路可达性
        this.vFinal = new Float32Array(totalCells); // 最终地价
        this.zones = new Uint8Array(totalCells); // 0商业 1居住 2工业 3郊区 4水体
        
        // 临时参数
        this.params = {
            seaLevel: 0.3,
            comZone: 0.85,
            roadDensity: 3
        };
    }

    // 更新参数
    updateParams(params) {
        Object.assign(this.params, params);
    }

    // 主生成流程
    async generate(baseX, baseY) {
        this.ctx.clearRect(0, 0, this.width, this.width);
        this.ctx.fillStyle = "#333";
        this.ctx.fillText("正在演算城市数据...", this.width/2 - 50, this.width/2);

        // 初始化 POI 列表
        this.pois = [];

        // 避免阻塞主线程，使用 setTimeout 进行异步分割
        await this.stepTerrain(baseX, baseY);
        await this.stepInitialLandValue();
        await this.stepRoads();
        await this.stepAccessibility();
        await this.stepFinalLandValue();
        await this.stepZones();
        await this.stepPOIs();
        
        this.renderFinal();
    }

    // --- 工具函数：获取主地图地形插值 ---
    getGlobalElevation(nx, ny) {
        // 由于我们在外部将主对象绑定为 globalThis.generator，此处直接访问它
        const mapGen = typeof generator !== 'undefined' ? generator : window.generator;
        if (!mapGen || !mapGen.cells || mapGen.cells.length === 0) {
            return { e: this.params.seaLevel + 0.1, isWater: false };
        }
        let gw = mapGen.width;
        let gh = mapGen.height;
        
        // 映射到主地图像素坐标
        let px = nx * gw;
        let py = ny * gh;
        
        // 双线性插值
        let x0 = Math.floor(px);
        let y0 = Math.floor(py);
        let x1 = (x0 + 1) % gw;
        let y1 = Math.min(y0 + 1, gh - 1);
        
        let tx = px - x0;
        let ty = py - y0;
        
        let c00 = mapGen.cells[y0 * gw + x0];
        let c10 = mapGen.cells[y0 * gw + x1];
        let c01 = mapGen.cells[y1 * gw + x0];
        let c11 = mapGen.cells[y1 * gw + x1];
        
        if (!c00 || !c10 || !c01 || !c11) return { e: this.params.seaLevel + 0.1, isWater: false };
        
        let e0 = c00.e * (1 - tx) + c10.e * tx;
        let e1 = c01.e * (1 - tx) + c11.e * tx;
        let e = e0 * (1 - ty) + e1 * ty;
        
        // 判定如果是主地图上的湖泊或河流
        let waterForce = c00.isLake || c00.isRiver || c10.isLake || c10.isRiver || c01.isLake || c01.isRiver || c11.isLake || c11.isRiver;
        
        return { e: e, isWater: waterForce };
    }

    // 1. 专门为城市定制的沙盒地形生成 (平原 + 蜿蜒河流 + 局部山地)
    stepTerrain(baseX, baseY) {
        return new Promise(resolve => {
            const mapGen = typeof generator !== 'undefined' ? generator : window.generator;
            const noise = (mapGen && mapGen.simplex) ? 
                (x, y) => mapGen.simplex.noise2D(x, y) : 
                (x, y) => Math.sin(x)*Math.cos(y); // 容错后备

            // 利用点击坐标产生偏移，保证每次点击生成的河山分布不同
            const ox = baseX * 100;
            const oy = baseY * 100;

            for(let y = 0; y < this.height; y++) {
                for (let x = 0; x < this.width; x++) {
                    const idx = y * this.width + x;
                    
                    // 城市内部的缩放坐标
                    let nx = ox + (x / this.width) * 2.5;
                    let ny = oy + (y / this.width) * 2.5;
                    
                    // 1. 基础大平原：略高于海平面，非常平坦适合建城
                    let e = this.params.seaLevel + 0.02; 
                    
                    // 2. 局部山脉或丘陵：增加更多的分形细节，消除圆滑感，使其崎岖破碎
                    let hillMask = noise(nx * 0.8, ny * 0.8);
                    if (hillMask > 0.1) {
                        let intensity = (hillMask - 0.1) / 0.9;
                        // 叠加三层高频噪声以增加极端的崎岖度
                        let hDetail = noise(nx * 2, ny * 2) * 0.15 + 
                                      noise(nx * 4, ny * 4) * 0.1 + 
                                      noise(nx * 8, ny * 8) * 0.05 + 
                                      noise(nx * 16, ny * 16) * 0.025;
                        e += intensity * (0.25 + hDetail);
                    }
                    
                    // 3. 贯穿城市的蜿蜒主干河流 (带有几何化或崎岖边缘的河谷)
                    let riverPath = Math.abs(noise(nx * 0.6 + 50, ny * 0.6 + 50)); // 低频骨架
                    
                    // 制造更强烈的高频、分形侵蚀，使得河岸看起来更加崎岖破碎，不再圆润
                    let fractalDistortion = noise(nx * 4, ny * 4) * 0.1 + noise(nx * 8, ny * 8) * 0.05 + noise(nx * 16, ny * 16) * 0.025;
                    let finalRiverDist = riverPath + fractalDistortion;
                    
                    let riverWidth = 0.12; // 河流宽度
                    if (finalRiverDist < riverWidth) {
                        // 越靠近河中心下沉越深
                        let carve = Math.pow(1.0 - (finalRiverDist / riverWidth), 1.5);
                        e -= carve * 0.2; 
                    }
                    
                    // 4. 为平原增加极轻微的起伏，避免像镜面一样绝对水平
                    if (finalRiverDist >= riverWidth && hillMask <= 0.1) {
                        e += noise(nx * 10, ny * 10) * 0.005;
                    }
                    
                    // 严格限制范围
                    e = Math.max(0, Math.min(1, e));
                    
                    this.heightMap[idx] = e;
                    // 判定水域：低于海平面的部分全变成水
                    this.waterMask[idx] = e <= this.params.seaLevel ? 1 : 0;
                }
            }
            resolve();
        });
    }

    // --- 工具函数：获取地形梯度 (用于道路避障与等高线跟随) ---
    getGradient(x, y) {
        if (x <= 0 || x >= this.width - 1 || y <= 0 || y >= this.height - 1) return {dx: 0, dy: 0, mag: 0};
        let h_left = this.heightMap[y * this.width + x - 1];
        let h_right = this.heightMap[y * this.width + x + 1];
        let h_up = this.heightMap[(y - 1) * this.width + x];
        let h_down = this.heightMap[(y + 1) * this.width + x];
        let dx = (h_right - h_left) * 0.5;
        let dy = (h_down - h_up) * 0.5;
        return {dx: dx, dy: dy, mag: Math.sqrt(dx*dx + dy*dy)};
    }

    // 2. 计算初始地价 P_terrain
    stepInitialLandValue() {
        return new Promise(resolve => {
            for(let y = 0; y < this.height; y++) {
                for (let x = 0; x < this.width; x++) {
                    const idx = y * this.width + x;
                    if (this.waterMask[idx]) {
                        this.pTerrain[idx] = 0;
                        continue;
                    }
                    
                    // 废弃之前的单一中心圆形辐射！引入自然的分形噪声与多中心结构来决定地价潜能
                    // 这会让城市建成区呈现自然的不规则蔓延，而非一个死板的大圆球。
                    
                    // 1. 低频地形噪声（模拟资源/区位潜力的自然分布）
                    let noiseVal = window.cityGenNoise ? window.cityGenNoise.noise2D(x * 0.003, y * 0.003) : 0;
                    let val = 0.5 + noiseVal * 0.4;
                    
                    // 2. 彻底移除所有中心衰减的圆形算法，避免地图上出现硬性的圆圈轮廓。
                    // 改用一个独立的较高频地形噪声来模拟局部的商业繁华度聚集。
                    let localNoise = window.cityGenNoise ? window.cityGenNoise.noise2D(x * 0.015, y * 0.015) : 0;
                    val += localNoise * 0.2;
                    
                    // 3. 地形平坦度加权 (人们倾向于在平地建城，陡坡地价低)
                    let grad = this.getGradient(x, y);
                    val -= grad.mag * 4.0; // 加大陡坡惩罚，让建筑避开山脊
                    val += (1.0 - this.heightMap[idx]) * 0.4; // 平原和低地有更大的开发潜能
                    
                    this.pTerrain[idx] = Math.max(0, Math.min(1, val));
                }
            }
            resolve();
        });
    }

    // --- 工具函数：在数组中画线 (Bresenham) ---
    drawLine(x0, y0, x1, y1, type, width) {
        let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
        let dy = Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1; 
        let err = (dx > dy ? dx : -dy) / 2, e2;
        
        while (true) {
            // 根据线宽绘制
            for(let wy = -width; wy <= width; wy++){
                for(let wx = -width; wx <= width; wx++){
                    let px = x0 + wx, py = y0 + wy;
                    if (px >= 0 && px < this.width && py >= 0 && py < this.height) {
                        let idx = py * this.width + px;
                        // 移除水域限制，允许把路画在水上（作为桥梁）
                        this.roadNetwork[idx] = Math.max(this.roadNetwork[idx], type);
                    }
                }
            }
            if (x0 === x1 && y0 === y1) break;
            e2 = err;
            if (e2 > -dx) { err -= dy; x0 += sx; }
            if (e2 < dy) { err += dx; y0 += sy; }
        }
    }

    // --- 工具函数：带碰撞检测的智能画线 ---
    // 返回实际结束点的坐标，如果提前碰撞到其他路就返回碰撞点
    drawSmartLine(x0, y0, angle, length, type, width) {
        let dx = Math.cos(angle);
        let dy = Math.sin(angle);
        let cx = x0, cy = y0;
        let hit = false;
        
        for (let step = 1; step <= length; step++) {
            cx = x0 + dx * step;
            cy = y0 + dy * step;
            let px = Math.floor(cx);
            let py = Math.floor(cy);
            
            if (px < 5 || px >= this.width-5 || py < 5 || py >= this.height-5) {
                hit = true; break;
            }
            let idx = py * this.width + px;
            
            if (this.waterMask[idx]) {
                // 如果是主干道(type > 1)，尝试跨越水域建桥！
                if (type > 1) {
                    let foundLand = false;
                    // 前瞻探路
                    for (let f = 1; f <= 50; f++) {
                        let fx = Math.floor(cx + dx * f);
                        let fy = Math.floor(cy + dy * f);
                        if (fx < 5 || fx >= this.width-5 || fy < 5 || fy >= this.height-5) break;
                        if (!this.waterMask[fy * this.width + fx]) {
                            foundLand = true;
                            step += f; // 直接跳跃到对岸
                            cx = x0 + dx * step;
                            cy = y0 + dy * step;
                            break;
                        }
                    }
                    if (!foundLand) {
                        hit = true; break; // 对岸太远，不建桥
                    }
                } else {
                    hit = true; break; // 支路不建桥
                }
            }
            
            // 忽略起点附近的检测，但在走了一小段后，如果碰到其他路，就执行捕捉(Snap)
            if (step > 6 && this.roadNetwork[idx] > 0 && !this.waterMask[idx]) {
                hit = true;
                // 向前多走一点点确保完全连接
                cx += dx * 2; cy += dy * 2;
                break; 
            }
        }
        
        // 真正画线
        this.drawLine(Math.floor(x0), Math.floor(y0), Math.floor(cx), Math.floor(cy), type, width);
        return {x: cx, y: cy, hit: hit};
    }

    // 3. 道路生成 (Road Network) - 有机骨架与正交填充混合算法
    stepRoads() {
        return new Promise(resolve => {
            this.roadNetwork.fill(0);
            
            // 1. 寻找几个城市主次中心作为吸引点
            let centers = [];
            for(let i=0; i<4; i++) {
                let rx = 50 + Math.random()*(this.width-100);
                let ry = 50 + Math.random()*(this.width-100);
                    if (!this.waterMask[Math.floor(ry)*this.width+Math.floor(rx)]) {
                        centers.push({x: rx, y: ry});
                    }
                }
                if(centers.length === 0) {
                    // 如果随机选点全在水里，就随便选一个不靠水的陆地，而不是死板地放在画布中心
                    for (let i = 0; i < this.width * this.height; i++) {
                        if (!this.waterMask[i]) {
                            centers.push({x: i % this.width, y: Math.floor(i / this.width)});
                            break;
                        }
                    }
                    if (centers.length === 0) centers.push({x: this.width/2, y: this.height/2});
                }
                let mainCenter = centers[0];
                
                let branches = [];
            // type: 3主干(有机), 2次干(网格), 1支路(网格)
            
            // 放射出几条主干道
            let numMain = 4 + Math.random()*3;
            for(let i=0; i<numMain; i++) {
                branches.push({x: mainCenter.x, y: mainCenter.y, angle: (i/numMain)*Math.PI*2, length: 15, type: 3, generation: 0, life: 30});
            }

            let count = 0;
            let maxCount = this.params.roadDensity * 800; // 提高总计算量允许细密路网

            while(branches.length > 0 && count < maxCount) {
                let b = branches.shift();
                count++;

                let currentAngle = b.angle;
                let stepLength = b.length;

                // 计算当前位置的坡度
                let grad = this.getGradient(Math.floor(b.x), Math.floor(b.y));
                let slopeMag = grad.mag;
                let isSteep = slopeMag > 0.015; // 超过此阈值认为是山地

                // 如果太陡峭（悬崖），禁止修建并终结这条路
                if (slopeMag > 0.04) continue;

                // 主干道：有机生长，寻找中心点或跟随地形
                if (b.type === 3) {
                    if (isSteep) {
                        // 【山地模式】 盘山公路逻辑：主干道顺着等高线（垂直于梯度）走
                        let contourAngle1 = Math.atan2(grad.dy, grad.dx) + Math.PI/2;
                        let contourAngle2 = Math.atan2(grad.dy, grad.dx) - Math.PI/2;
                        // 选择与当前方向更接近的一条等高线方向
                        let diff1 = Math.cos(currentAngle - contourAngle1);
                        let diff2 = Math.cos(currentAngle - contourAngle2);
                        let targetAngle = diff1 > diff2 ? contourAngle1 : contourAngle2;
                        // 平滑转向等高线
                        let d = targetAngle - currentAngle;
                        while(d <= -Math.PI) d += Math.PI*2;
                        while(d > Math.PI) d -= Math.PI*2;
                        currentAngle += d * 0.8; 
                        
                        stepLength = 10 + Math.random()*5; // 山路较短较密
                    } else {
                        // 【平原模式】 有机蜿蜒，倾向于寻找副中心
                        currentAngle += (Math.random() - 0.5) * 0.3;
                        if (Math.random() < 0.2 && centers.length > 1) {
                            let target = centers[Math.floor(Math.random()*centers.length)];
                            let angleToTarget = Math.atan2(target.y - b.y, target.x - b.x);
                            let diff = angleToTarget - currentAngle;
                            while(diff <= -Math.PI) diff += Math.PI*2;
                            while(diff > Math.PI) diff -= Math.PI*2;
                            currentAngle += diff * 0.15;
                        }
                        stepLength = 15 + Math.random()*10;
                    }
                } else {
                    // 次干道和支路
                    if (isSteep) {
                        // 【山地模式】 山区的次干道不再是直角，而是顺应地形的蜿蜒小径
                        currentAngle += (Math.random() - 0.5) * 0.8; // 随机扭曲加大
                        stepLength = b.type === 2 ? 20 : 12;
                    } else {
                        // 【平原模式】 严格正交的规划网格街区
                        stepLength = b.type === 2 ? 40 : 20;
                    }
                }

                let lineWidth = b.type === 3 ? 2 : (b.type === 2 ? 1 : 0);
                
                // 试探前行并进行碰撞/捕捉
                let endNode = this.drawSmartLine(b.x, b.y, currentAngle, stepLength, b.type, lineWidth);
                
                // 如果碰撞了，这根树枝死亡（完美闭合形成街区，不再长出子枝）
                if (endNode.hit) continue;

                // 没有碰撞，继续生长子枝
                if (b.type === 3) {
                    if (b.life > 0) {
                        // 主干道继续向前
                        branches.push({x: endNode.x, y: endNode.y, angle: currentAngle, length: stepLength, type: 3, generation: b.generation, life: b.life - 1});
                        
                        // 偶尔分叉出新的主干道
                        if (Math.random() < 0.1 && b.life > 10) {
                            let sign = Math.random() > 0.5 ? 1 : -1;
                            branches.push({x: endNode.x, y: endNode.y, angle: currentAngle + sign * (Math.PI/4 + Math.random()*0.2), length: stepLength, type: 3, generation: b.generation, life: b.life - 10});
                        }
                        
                        // 频繁向两侧射出次干道 (生成网格基准)
                        if (Math.random() < 0.6) {
                            branches.push({x: endNode.x, y: endNode.y, angle: currentAngle + Math.PI/2, length: 40, type: 2, generation: 0, life: 10});
                        }
                        if (Math.random() < 0.6) {
                            branches.push({x: endNode.x, y: endNode.y, angle: currentAngle - Math.PI/2, length: 40, type: 2, generation: 0, life: 10});
                        }
                    }
                } else {
                    // 次干道/支路的网格裂变
                    if (b.life > 0) {
                        // 继续直行
                        branches.push({x: endNode.x, y: endNode.y, angle: currentAngle, length: stepLength, type: b.type, generation: b.generation+1, life: b.life - 1});
                        
                        // 向两侧分裂（严格 90 度）
                        let nextType = b.generation > 2 ? 1 : 2; // 逐渐降级为细支路
                        
                        if (Math.random() < 0.5) {
                            branches.push({x: endNode.x, y: endNode.y, angle: currentAngle + Math.PI/2, length: 20, type: nextType, generation: b.generation+1, life: b.life - 2});
                        }
                        if (Math.random() < 0.5) {
                            branches.push({x: endNode.x, y: endNode.y, angle: currentAngle - Math.PI/2, length: 20, type: nextType, generation: b.generation+1, life: b.life - 2});
                        }
                    }
                }
            }
            resolve();
        });
    }

    // 4. 可达性场 (基于道路的模糊扩张)
    stepAccessibility() {
        return new Promise(resolve => {
            // 初始化权重
            for (let i = 0; i < this.width * this.height; i++) {
                if (this.roadNetwork[i] === 3) this.rRoad[i] = 1.0;
                else if (this.roadNetwork[i] === 2) this.rRoad[i] = 0.6;
                else if (this.roadNetwork[i] === 1) this.rRoad[i] = 0.3;
                else this.rRoad[i] = 0.0;
            }

            // 执行两次快速 Box Blur 以逼近高斯辐射，模拟道路带动周边地价
            let blurRadius = 15;
            let temp = new Float32Array(this.width * this.height);
            
            for(let pass = 0; pass < 2; pass++) {
                // 水平模糊
                for(let y = 0; y < this.height; y++) {
                    for(let x = 0; x < this.width; x++) {
                        let sum = 0, count = 0;
                        for(let k = -blurRadius; k <= blurRadius; k+=3) {
                            let nx = x + k;
                            if(nx >= 0 && nx < this.width) {
                                sum += this.rRoad[y * this.width + nx];
                                count++;
                            }
                        }
                        temp[y * this.width + x] = sum / count;
                    }
                }
                // 垂直模糊
                for(let x = 0; x < this.width; x++) {
                    for(let y = 0; y < this.height; y++) {
                        let sum = 0, count = 0;
                        for(let k = -blurRadius; k <= blurRadius; k+=3) {
                            let ny = y + k;
                            if(ny >= 0 && ny < this.height) {
                                sum += temp[ny * this.width + x];
                                count++;
                            }
                        }
                        this.rRoad[y * this.width + x] = sum / count;
                    }
                }
            }

            // 归一化并放大微弱信号
            let maxR = 0.01;
            for(let i=0; i<this.rRoad.length; i++) if(this.rRoad[i] > maxR) maxR = this.rRoad[i];
            for(let i=0; i<this.rRoad.length; i++) this.rRoad[i] = Math.min(1.0, (this.rRoad[i] / maxR) * 1.5);

            resolve();
        });
    }

    // 5. 最终地价 V_final
    stepFinalLandValue() {
        return new Promise(resolve => {
            for (let idx = 0; idx < this.width * this.height; idx++) {
                if (this.waterMask[idx]) {
                    this.vFinal[idx] = 0;
                    continue;
                }
                // V_final = P_terrain × (1 + γ·R_road)
                let gamma = 2.0;
                this.vFinal[idx] = this.pTerrain[idx] * (1 + gamma * this.rRoad[idx]);
                this.vFinal[idx] = Math.min(1, this.vFinal[idx]);
            }
            resolve();
        });
    }

    // 6. 区域划分 (Zoning) - 加入内部微型街道，形成规整的几何建筑区块
    async stepZones() {
        return new Promise(resolve => {
            // 生成城市街区网格，通过内部的微型街道切分形成建筑区块，避免无规律的马赛克感
            this.geoMask = new Float32Array(this.width * this.height);
            for(let y = 0; y < this.height; y++) {
                for(let x = 0; x < this.width; x++) {
                    let isStreet = false;
                    
                    // 1. 动态对齐道路的街区网格
                    // 我们想要让这些内部小街不仅仅是死板的绝对网格，而是跟周边的主路有关联。
                    // 但是因为这只是纯视觉的镂空层，最简单的方法是让它的间距变得像城市块。
                    // 这里我们加入一些简单的位移错位（Staggered Grid），使它看起来更像真实的街道相互拼接。
                    let blockModX = x % 24;
                    let blockModY = y % 24;
                    
                    // 利用 y 的区段给 x 的网格增加偏移，形成“丁字路口”错位感
                    let staggerX = (Math.floor(y / 24) % 2 === 0) ? 0 : 12;
                    let blockModX_staggered = (x + staggerX) % 24;
                    
                    if (blockModX_staggered < 2 || blockModY < 2) {
                        isStreet = true; // 主向网格，带错位
                    } else if (x % 12 < 1 || y % 12 < 1) {
                        // 次级填充小网格
                        isStreet = true;
                    }
                    
                    // 增加城市的错落感：大区块属性
                    let blockX = Math.floor(x / 18);
                    let blockY = Math.floor(y / 18);
                    let hash = Math.sin(blockX * 12.9898 + blockY * 78.233) * 43758.5453;
                    let blockHash = hash - Math.floor(hash);
                    
                    if (isStreet) {
                        // 有些大区块（如大型综合体）会覆盖次级小街，让它连成一大块
                        if ((x % 12 < 1 || y % 12 < 1) && blockHash > 0.6) {
                            this.geoMask[y * this.width + x] = 1.0; // 封死小街，连成大块
                        } else {
                            this.geoMask[y * this.width + x] = 0.0; // 正常的街道线条镂空
                        }
                    } else if (blockHash < 0.15) {
                        // 15%的大区块整体作为空出来的广场或绿地
                        this.geoMask[y * this.width + x] = 0.0;
                    } else {
                        this.geoMask[y * this.width + x] = 1.0; // 实心的方形建筑区
                    }
                }
            }

            // 获取所有陆地地价并排序寻找分位数
            let landValues = [];
            for (let i = 0; i < this.width * this.height; i++) {
                if (!this.waterMask[i]) landValues.push(this.vFinal[i]);
            }
            landValues.sort((a,b) => a-b);
            
            this.qCom = landValues[Math.floor(landValues.length * this.params.comZone)] || 0.8;
            this.qRes = landValues[Math.floor(landValues.length * 0.5)] || 0.5;
            
            for (let i = 0; i < this.width * this.height; i++) {
                if (this.waterMask[i]) {
                    this.zones[i] = 4; // 水
                } else if (this.roadNetwork[i] > 0) {
                    this.zones[i] = 5; // 道路不分区
                } else {
                    let v = this.vFinal[i];
                    // 判断是否为建筑实体：落在微型街道网格或广场镂空区域的像素视为非建筑区
                    let isBuiltUp = v >= this.qRes && this.geoMask[i] > 0.5;

                    if (isBuiltUp) {
                        if (v >= this.qCom) this.zones[i] = 0; // 商业
                        else this.zones[i] = 1; // 居住
                    } else {
                        // 如果不满足 isBuiltUp，直接视为未开发，从而在视觉上形成图2中建筑区内部的黑色空隙（露出的底色）
                        this.zones[i] = 4; // 未开发
                    }
                }
            }
            resolve();
        });
    }

    async stepPOIs() {
        return new Promise(resolve => {
            this.pois = [];
            // 简单的随机放置 POI 逻辑
            const poiTypes = [
                { type: 'airport', name: '国际机场', icon: '✈️', color: '#6A5ACD', condition: (vFinal, isWater, z) => !isWater && vFinal < 0.3 && z !== 0 },
                { type: 'square', name: '中心广场', icon: '⛲', color: '#FF8C00', condition: (vFinal, isWater, z) => !isWater && z === 0 },
                { type: 'scenic', name: '滨水风景区', icon: '🏞️', color: '#2E8B57', condition: (vFinal, isWater, z) => !isWater && vFinal > 0.6 },
                { type: 'hospital', name: '市第一医院', icon: '🏥', color: '#DC143C', condition: (vFinal, isWater, z) => !isWater && z === 1 },
                { type: 'school', name: '大学城', icon: '🎓', color: '#4169E1', condition: (vFinal, isWater, z) => !isWater && z === 1 }
            ];

            // 划分格子来放置POI，避免重叠
            const gridSize = 60;
            for(let y = 0; y < this.height; y += gridSize) {
                for (let x = gridSize/2; x < this.width; x += gridSize) {
                    let rx = Math.floor(x + (Math.random() * gridSize - gridSize/2));
                    let ry = Math.floor(y + (Math.random() * gridSize - gridSize/2));
                    
                    if (rx < 0 || rx >= this.width || ry < 0 || ry >= this.height) continue;
                    
                    let idx = ry * this.width + rx;
                    let vFinal = this.vFinal[idx];
                    let isWater = this.waterMask[idx];
                    let z = this.zones[idx];

                    // 随机打乱类型尝试放置
                    let shuffledTypes = poiTypes.slice().sort(() => Math.random() - 0.5);
                    for(let pt of shuffledTypes) {
                        if (pt.condition(vFinal, isWater, z)) {
                            // 添加一点随机偏移和名字变化
                            let nameSuffix = Math.random() > 0.5 ? '北区' : (Math.random() > 0.5 ? '南区' : '中心');
                            let finalName = pt.name;
                            if(pt.type === 'square' || pt.type === 'scenic') finalName += nameSuffix;
                            
                            this.pois.push({ x: rx, y: ry, name: finalName, icon: pt.icon, color: pt.color, type: pt.type });
                            break; // 每个格子最多一个
                        }
                    }
                }
            }
            resolve();
        });
    }

    // --- 工具函数：映射颜色热力图 ---
    getColorMap(val, minHue, maxHue) {
        // HSL 转 RGB 的简易版
        let h = (1.0 - val) * (maxHue - minHue) + minHue;
        let s = 1.0;
        let l = 0.5;
        let c = (1 - Math.abs(2 * l - 1)) * s;
        let x = c * (1 - Math.abs((h / 60) % 2 - 1));
        let m = l - c/2;
        let r=0, g=0, b=0;
        if(h>=0 && h<60) { r=c; g=x; b=0; }
        else if(h>=60 && h<120) { r=x; g=c; b=0; }
        else if(h>=120 && h<180) { r=0; g=c; b=x; }
        else if(h>=180 && h<240) { r=0; g=x; b=c; }
        else if(h>=240 && h<300) { r=x; g=0; b=c; }
        else { r=c; g=0; b=x; }
        return [Math.floor((r+m)*255), Math.floor((g+m)*255), Math.floor((b+m)*255)];
    }

    // 7. 渲染 (支持多种调试视图)
    renderFinal() {
        let viewMode = document.querySelector('input[name="cityViewMode"]:checked').value;
        const imgData = this.ctx.createImageData(this.width, this.height); // 修复初始化方形的 Bug
        const data = imgData.data;

        for(let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                let i = y * this.width + x;
                let idx = i * 4;
                let r=0, g=0, b=0;

                // 计算简单的 3D 光照阴影 (Hillshade)
                let grad = this.getGradient(x, y);
                // 假设光源在西北方向 (dx=1, dy=1), 高度一定
                let lightDx = 0.707, lightDy = 0.707; 
                // 点乘得到光照强度
                let shade = (grad.dx * lightDx + grad.dy * lightDy) * 5.0; // 放大系数
                shade = Math.max(-0.5, Math.min(0.5, shade)); // 限制阴影范围 (-0.5 到 0.5)

                if (viewMode === 'terrain') {
                    // 真实卫星地貌图 + 3D光照阴影
                    let h = this.heightMap[i];
                    if (this.waterMask[i]) { 
                        // 水域：浅蓝
                        r=74; g=163; b=223; 
                    } else {
                        // 根据高度上色：沙滩 -> 平原 -> 丘陵 -> 山脉
                        let baseR, baseG, baseB;
                        if (h < this.params.seaLevel + 0.05) {
                            baseR=241; baseG=215; baseB=150; // 沙滩
                        } else if (h < 0.6) {
                            baseR=120; baseG=200; baseB=120; // 平原草地
                        } else if (h < 0.8) {
                            baseR=60; baseG=140; baseB=60; // 森林/丘陵
                        } else {
                            baseR=150; baseG=150; baseB=150; // 山岩
                        }
                        
                        // 叠加阴影光照
                        let lightFactor = 1.0 + shade * 1.5; // 放大阴影对比度
                        r = baseR * lightFactor; 
                        g = baseG * lightFactor; 
                        b = baseB * lightFactor;
                    }
                } else if (viewMode === 'road') {
                    // 可达性场：热力图
                    if (this.waterMask[i]) { r=0; g=0; b=100; }
                    else {
                        let col = this.getColorMap(this.rRoad[i], 240, 0); // 蓝到红
                        r = col[0]; g = col[1]; b = col[2];
                    }
                } else if (viewMode === 'zone') {
                    // 纯净的分区图
                    let z = this.zones[i];
                    if (this.roadNetwork[i] > 0) { r=0; g=0; b=0; }
                    else if (z === 4) { r=52; g=152; b=219; }
                    else if (z === 0) { r=142; g=68; b=173; }
                    else if (z === 1) { r=241; g=196; b=15; }
                    else if (z === 3) { r=46; g=204; b=113; }
                } else {
                    // 最终渲染 - 多风格切换
                    let styleMode = document.querySelector('input[name="cityStyleMode"]:checked');
                    styleMode = styleMode ? styleMode.value : 'dark_blueprint';
                    
                    let h = this.heightMap[i];
                    let isWater = this.waterMask[i];
                    let z = this.zones[i];
                    
                    // 获取建筑网格内部镂空标志
                    let isGridGap = (z === 4 && this.geoMask && this.geoMask[i] === 0.0 && this.vFinal[i] >= this.qRes);
                    
                    if (styleMode === 'dark_blueprint') {
                        // 1. 赛博暗色蓝图 (图3风格)
                        if (this.roadNetwork[i] > 0) { r=255; g=255; b=255; }
                        else if (isWater) { r=45; g=45; b=60; }
                        else if (isGridGap) { r=75; g=75; b=95; }
                        else {
                            let baseR = 65, baseG = 65, baseB = 85;
                            if (z === 0) { r = 220; g = 220; b = 235; }
                            else if (z === 1) { r = 160; g = 160; b = 185; }
                            else if (z === 3) { r = 100; g = 100; b = 125; }
                            else { r = baseR; g = baseG; b = baseB; }
                            
                            let shadeFactor = 1.0 + shade * 0.15;
                            r *= shadeFactor; g *= shadeFactor; b *= shadeFactor;
                        }
                    } else if (styleMode === 'classic_nav') {
                        // 2. 经典浅色导航图 (图2高德/Google风格)
                        if (this.roadNetwork[i] > 0) { r=255; g=255; b=255; }
                        else if (isWater) { r=160; g=200; b=255; } // 浅蓝色水体
                        else if (isGridGap) { r=230; g=235; b=240; } // 浅灰色街道底色
                        else {
                            let baseR = 210, baseG = 235, baseB = 210; // 浅绿色自然底色
                            if (z === 0) { r = 255; g = 210; b = 210; } // 商业区浅红色
                            else if (z === 1) { r = 250; g = 240; b = 220; } // 居住区浅黄色
                            else if (z === 3) { r = 225; g = 240; b = 220; } // 郊区过渡色
                            else { r = baseR; g = baseG; b = baseB; }
                            
                            let shadeFactor = 1.0 + shade * 0.1; // 极弱的阴影
                            r *= shadeFactor; g *= shadeFactor; b *= shadeFactor;
                        }
                    } else if (styleMode === 'retro_paper') {
                        // 3. 复古规划纸图 (图1复古风格)
                        if (this.roadNetwork[i] > 0) { r=60; g=60; b=60; } // 黑色道路
                        else if (isWater) { r=173; g=216; b=230; } // 灰蓝色水体
                        else if (isGridGap) { r=240; g=230; b=215; } // 纸张本色街道
                        else {
                            let baseR = 245, baseG = 240, baseB = 225; // 发黄的图纸底色
                            if (z === 0) { r = 230; g = 170; b = 180; } // 复古红商业区
                            else if (z === 1) { r = 210; g = 200; b = 220; } // 复古紫居住区
                            else if (z === 3) { r = 220; g = 220; b = 200; } // 复古绿郊区
                            else { r = baseR; g = baseG; b = baseB; }
                            
                            let shadeFactor = 1.0 + shade * 0.2; // 稍微强一点的铅笔阴影质感
                            r *= shadeFactor; g *= shadeFactor; b *= shadeFactor;
                        }
                    }
                }

                data[idx] = Math.min(255, Math.max(0, r));
                data[idx+1] = Math.min(255, Math.max(0, g));
                data[idx+2] = Math.min(255, Math.max(0, b));
                data[idx+3] = 255;
            }
        }
        
        // 创建离屏 Canvas 来做平滑抗锯齿处理
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.width;
        tempCanvas.height = this.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imgData, 0, 0);

        // 绘制回主画布，同时叠加抗锯齿模糊以减轻“像素风”
        this.ctx.save();
        this.ctx.clearRect(0, 0, this.width, this.height);
        // 轻微的模糊滤镜，使像素点边缘柔和融合成一体，形成丝滑的高级感
        if (viewMode === 'final') {
            this.ctx.filter = 'blur(0.8px) contrast(1.1) saturate(1.1)';
        }
        this.ctx.drawImage(tempCanvas, 0, 0);
        this.ctx.restore();
    }
}

// 实例化全局城建器
window.cityGen = null;
