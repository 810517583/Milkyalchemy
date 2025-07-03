(function() {
    const ac_prefix = 'ac_';
    
    // 获取DOM元素 v148
    const ac_getElement = (id) => document.getElementById(id);
    
    // 格式化时间显示（秒 → 分钟/小时）
    function ac_formatTime(seconds) {
        if (seconds < 60) {
            return `${seconds.toFixed(1)}秒`;
        }        
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;        
        if (minutes < 60) {
            return `${minutes}分${remainingSeconds > 0 ? remainingSeconds.toFixed(1) + '秒' : ''}`;
        }        
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;        
        return `${hours}小时${remainingMinutes > 0 ? remainingMinutes + '分' : ''}`;
    }
	// 新增函数：计算实际动作次数
	function calculateActualAttempts(baseAttempts, efficiencyRate) {
    let actualAttempts = 0;
    for (let i = 0; i < baseAttempts; i++) {
        // 基础动作
        actualAttempts += 1;        
        // 基础重复（效率≤100%部分）
        if (efficiencyRate > 0) {
            const baseChance = Math.min(efficiencyRate, 100) / 100;
            if (Math.random() < baseChance) {
                actualAttempts += 1;
            }            
            // 额外重复（效率>100%部分）
            if (efficiencyRate > 100) {
                const extraChance = (efficiencyRate - 100) / 100;
                if (Math.random() < extraChance) {
                    actualAttempts += 1;
                }
            }
        }
    }
    return actualAttempts;
}
    
    // 模拟炼金过程
    function ac_simulateAlchemy() {
		document.querySelectorAll('.output-allquantity').forEach(input => {
        input.value = '0';
    });
        const simulateTimes = parseInt(ac_getElement('simulateTimes').value) || 0;
		const efficiencyRate = parseInt(ac_getElement('efficiencyRate').value) || 0;
		const successRate = parseInt(ac_getElement('successRate').value) || 0;
		const baseTimePerTry = parseInt(ac_getElement('timePerTry').value) || 0;
        
        // 验证输入
        if (simulateTimes <= 0 || simulateTimes > 1000000) {
            alert('请输入1-1000000之间的模拟次数');
            return;
        }
        
        if (successRate < 0 || successRate > 100) {
            alert('成功率必须在0-100之间');
            return;
        }
        
        if (efficiencyRate < 0 || efficiencyRate > 200) {
            alert('效率必须在0-200之间');
            return;successCount 
        }

        
        // 获取产出物品信息
        const outputRows = document.querySelectorAll('#outputItems tr');
        const items = [];
        let totalProbability = 0;
        
        outputRows.forEach(row => {
            const probability = parseFloat(row.querySelector('.output-probability').value) || 0;
            const itemName = row.querySelector('.output-item').value;
            const price = parseInt(row.querySelector('.output-price').value) || 0;
			const baseQuantity = parseInt(row.querySelector('.output-quantity').value) || 1;
            
            items.push({
                name: itemName,
				probability,
				price,
				baseQuantity, // 单次掉落数量（output-quantity）
				currentQuantity: 0, // 本次模拟的数量
				total: 0
            });
            
            totalProbability += probability;
        });
        
        // 验证概率总和
        const roundedTotal = Math.round(totalProbability * 100) / 100;
        if (roundedTotal !== 100) {
            alert(`所有物品的概率总和必须为100%，当前为${totalProbability.toFixed(2)}%`);
            return;
        }
        
        // 重置物品数量
        items.forEach(item => {
            item.quantity = 0;
            item.total = 0;
        });
        
        // 开始模拟
		const totalActions = calculateActualAttempts(simulateTimes, efficiencyRate);
		const baseTotalTime = simulateTimes * baseTimePerTry;
		const totalTime = baseTotalTime * (simulateTimes / totalActions);
		let successCount = 0;
		for (let i = 0; i < simulateTimes; i++) {  // 保持用基础次数
        if (Math.random() * 100 < successRate) {
            successCount++;            
            // 随机选择产出物品（保持不变）
            let random = Math.random() * 100;
            let accumulated = 0;            
            for (const item of items) {
                accumulated += item.probability;
                if (random <= accumulated) {
                    item.currentQuantity += item.baseQuantity;
                    item.total += item.price * item.baseQuantity;
                    break;
                }
            }
        }
    }
        // 更新UI显示物品数量
        outputRows.forEach((row, index) => {
			const item = items[index];
            // 显示本次模拟结果
			row.querySelector('.output-allquantity').value = 
            (parseInt(row.querySelector('.output-allquantity').value) || 0) + item.currentQuantity;
            // 显示本次模拟的总价
			row.querySelector('.output-total').value = item.total;
        });        
        // 计算并显示结果
        ac_getElement('timeCost').textContent = ac_formatTime(totalTime);
        // 存储成功次数
        if (!ac_getElement('successCount')) {
        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.id = 'successCount';
        document.body.appendChild(hiddenInput);
    }
    ac_getElement('successCount').value = successCount;
        // 触发盈亏计算
        ac_calculateProfit();
    }
    
    // 计算盈亏
    function ac_calculateProfit() {
        // 计算总成本
        const ac_simulateTimes = parseFloat(ac_getElement('simulateTimes').value) || 0;
        const ac_allCostPerTry = parseFloat(ac_getElement('allcostPerTry').value) || 0;
        const ac_catalystCost = parseFloat(ac_getElement('Catalyst').value) || 0;
        // 获取成功次数（从模拟结果中获取）
        const successCount = parseInt(ac_getElement('successCount')?.value) || 0;
        const failCount = ac_simulateTimes - successCount;
        const ac_totalCost = (ac_simulateTimes * ac_allCostPerTry) - (failCount * ac_catalystCost);

        ac_getElement('totalCost').textContent = ac_totalCost.toLocaleString();
        
        // 计算产出物品总价
        let ac_totalOutputValue = 0;
		document.querySelectorAll('#outputItems tr').forEach(row => {
        const quantity = parseInt(row.querySelector('.output-allquantity').value) || 0;
        const price = parseInt(row.querySelector('.output-price').value) || 0;
        ac_totalOutputValue += quantity * price;
    });
        
        // 计算盈亏
        const ac_profitLoss = ac_totalOutputValue - ac_totalCost;
		const ac_profitElement = ac_getElement('profitLoss');
        
        ac_profitElement.textContent = ac_profitLoss.toLocaleString();
		ac_profitElement.className = 'result-value ' + 
        (ac_profitLoss >= 0 ? 'profit' : 'loss');
    }
    
    // 计算单次成本
    function ac_calculateSingleCost() {
        const ac_itemPrice = parseFloat(ac_getElement('itemPrice').value) || 0;
        const ac_catalystCost = parseFloat(ac_getElement('Catalyst').value) || 0;
        const ac_costPerTry = parseFloat(ac_getElement('costPerTry').value) || 0;
        
        const ac_singleCost = ac_itemPrice + ac_catalystCost + ac_costPerTry;
        ac_getElement('allcostPerTry').value = ac_singleCost;
        
        // 触发重新计算
        ac_calculateProfit();
    }
    
    // 初始化事件监听器
    function ac_initEventListeners() {
        // 监听所有相关输入的变化
        const ac_inputsToWatch = [
            'simulateTimes', 'itemPrice', 'Catalyst', 'costPerTry', 
            'timePerTry', 'successRate', 'efficiencyRate'
        ];
        
        ac_inputsToWatch.forEach(id => {
            ac_getElement(id).addEventListener('input', ac_calculateSingleCost);
        });
        
        // 监听产出物品表格的变化
        document.querySelectorAll('#outputItems .output-price, #outputItems .output-probability').forEach(input => {
            input.addEventListener('input', ac_calculateProfit);
        });
        
        // 监听开始炼金按钮
        ac_getElement('startBtn').addEventListener('click', ac_simulateAlchemy);
    }
    
    // 初始化计算器
    function ac_initCalculator() {
        ac_initEventListeners();
        ac_calculateSingleCost(); // 初始计算
    }
    
    // 当DOM加载完成后初始化
    document.addEventListener('DOMContentLoaded', ac_initCalculator);
    
    // 暴露必要的函数到全局
    window.alchemyCalculator = {
        simulateAlchemy: ac_simulateAlchemy,
        calculateProfit: ac_calculateProfit,
        calculateSingleCost: ac_calculateSingleCost,
        formatTime: ac_formatTime
    };
})();