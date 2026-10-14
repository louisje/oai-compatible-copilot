const vscode = acquireVsCodeApi();
const state = {
	baseUrl: "",
	apiKey: "",
	delay: 0,
	retry: { enabled: true, max_attempts: 3, interval_ms: 1000, status_codes: [429, 500, 502, 503, 504] },
	commitModel: "",
	models: [],
	manualModels: [],
	discoveredModels: [],
	chatgptConnected: false,
	disabledProviders: [],
	hiddenProviders: [],
	providerKeys: {},
	providerInfo: {},
};

// Independent sort settings for the two management tables. Kept in webview state
// across a panel reload, without changing the order saved in workspace settings.
const savedSort = vscode.getState()?.tableSort || {};
const tableSort = {
	providerTable: savedSort.providerTable || { key: "provider", direction: "asc" },
	modelTable: savedSort.modelTable || { key: "id", direction: "asc" },
};
const sortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareSortValues(a, b) {
	const emptyA = a === undefined || a === null || a === "";
	const emptyB = b === undefined || b === null || b === "";
	// Empty cells always come last, regardless of the direction.
	if (emptyA !== emptyB) {
		return emptyA ? 1 : -1;
	}
	if (emptyA) {
		return 0;
	}
	if (typeof a === "number" && typeof b === "number") {
		return a - b;
	}
	return sortCollator.compare(String(a), String(b));
}

function sortRows(rows, table, getValue, fallback) {
	const { key, direction } = tableSort[table];
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const first = getValue(a.row, key);
			const second = getValue(b.row, key);
			const isEmpty = (v) => v === undefined || v === null || v === "";
			let result = compareSortValues(first, second);
			if (!isEmpty(first) && !isEmpty(second) && direction === "desc") {
				result *= -1;
			}
			return result || sortCollator.compare(fallback(a.row), fallback(b.row)) || a.index - b.index;
		})
		.map(({ row }) => row);
}

function renderSortIndicators(table) {
	const { key, direction } = tableSort[table];
	document.querySelectorAll(`#${table} thead th[data-sort-key]`).forEach((header) => {
		header.setAttribute(
			"aria-sort",
			header.dataset.sortKey === key ? (direction === "asc" ? "ascending" : "descending") : "none"
		);
		const button = header.querySelector("button");
		button.title = `Sort by ${button.textContent.trim()} (${header.dataset.sortKey === key ? direction : "asc"})`;
	});
}

for (const table of ["providerTable", "modelTable"]) {
	document.querySelectorAll(`#${table} thead .table-sort-button`).forEach((button) => {
		button.addEventListener("click", () => {
			const key = button.dataset.sortKey;
			tableSort[table] = {
				key,
				direction: tableSort[table].key === key && tableSort[table].direction === "asc" ? "desc" : "asc",
			};
			vscode.setState({ ...vscode.getState(), tableSort });
			if (table === "providerTable") {
				renderProviders();
			} else {
				renderModels();
			}
		});
	});
	renderSortIndicators(table);
}

function providerSortValue(provider, key) {
	const models = state.manualModels.filter((m) => m.owned_by === provider && !m.chatgptAuth);
	const first = models[0] || {};
	switch (key) {
		case "provider":
			return provider;
		case "enabled":
			return !state.disabledProviders.some((p) => p.toLowerCase() === provider.toLowerCase()) ? 1 : 0;
		case "hidden":
			return state.hiddenProviders.some((p) => p.toLowerCase() === provider.toLowerCase()) ? 1 : 0;
		case "baseUrl":
			return first.baseUrl;
		case "apiMode":
			return first.apiMode;
		default:
			return "";
	}
}

function modelSortValue(model, key) {
	switch (key) {
		case "auth":
			return model.chatgptAuth ? "ChatGPT" : "API Key";
		case "maxTokens":
			return model.max_completion_tokens ?? model.max_tokens ?? model.catalog_max_output_tokens;
		case "price":
			return model.pricing?.input;
		case "enabled":
			return model.enabled !== false ? 1 : 0;
		case "vision":
			return model.vision ? 1 : 0;
		default:
			return model[key];
	}
}

// Store the action to be performed after confirmation
const pendingConfirmations = new Map();

// Global Configuration elements
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const delayInput = document.getElementById("delay");
const readFileLinesInput = document.getElementById("readFileLines");
const retryEnabledInput = document.getElementById("retryEnabled");
const maxAttemptsInput = document.getElementById("maxAttempts");
const intervalMsInput = document.getElementById("intervalMs");
const statusCodesInput = document.getElementById("statusCodes");

// Provider management elements
const providerTableBody = document.getElementById("providerTableBody");

// Model management elements
const modelTableBody = document.getElementById("modelTableBody");
const chatgptStatus = document.getElementById("chatgptStatus");
const chatgptSummary = document.getElementById("chatgptModelSummary");
const chatgptSignInBtn = document.getElementById("chatgptSignIn");
const chatgptSignOutBtn = document.getElementById("chatgptSignOut");
const chatgptRefreshBtn = document.getElementById("chatgptRefresh");
const modelChatGPTAuthInput = document.getElementById("modelChatGPTAuth");
const modelFormSection = document.getElementById("modelFormSection");
const modelFormTitle = document.getElementById("modelFormTitle");
const modelIdInput = document.getElementById("modelIdInput");
const modelIdDropdown = document.getElementById("modelIdDropdown");
const modelProviderInput = document.getElementById("modelProvider");
const modelEnabledInput = document.getElementById("modelEnabled");
const modelDisplayNameInput = document.getElementById("modelDisplayName");
const modelConfigIdInput = document.getElementById("modelConfigId");
const modelBaseUrlInput = document.getElementById("modelBaseUrl");
const modelFamilyInput = document.getElementById("modelFamily");
const modelContextLengthInput = document.getElementById("modelContextLength");
const modelMaxTokensInput = document.getElementById("modelMaxTokens");
const modelVisionInput = document.getElementById("modelVision");
const modelApiModeInput = document.getElementById("modelApiMode");
const modelTemperatureInput = document.getElementById("modelTemperature");
const modelTopPInput = document.getElementById("modelTopP");
const modelDelayInput = document.getElementById("modelDelay");
const modelPriceInputInput = document.getElementById("modelPriceInput");
const modelPriceOutputInput = document.getElementById("modelPriceOutput");
const modelPriceCacheReadInput = document.getElementById("modelPriceCacheRead");
const modelPriceCacheWriteInput = document.getElementById("modelPriceCacheWrite");
const modelTopKInput = document.getElementById("modelTopK");
const modelMinPInput = document.getElementById("modelMinP");
const modelFrequencyPenaltyInput = document.getElementById("modelFrequencyPenalty");
const modelPresencePenaltyInput = document.getElementById("modelPresencePenalty");
const modelRepetitionPenaltyInput = document.getElementById("modelRepetitionPenalty");
const modelReasoningEffortInput = document.getElementById("modelReasoningEffort");
const modelEnableThinkingInput = document.getElementById("modelEnableThinking");
const modelThinkingBudgetInput = document.getElementById("modelThinkingBudget");
const modelIncludeReasoningInput = document.getElementById("modelIncludeReasoning");
const modelMaxCompletionTokensInput = document.getElementById("modelMaxCompletionTokens");
const modelReasoningEnabledInput = document.getElementById("modelReasoningEnabled");
const modelReasoningExcludeInput = document.getElementById("modelReasoningExclude");
const modelReasoningEffortORInput = document.getElementById("modelReasoningEffortOR");
const modelReasoningMaxTokensInput = document.getElementById("modelReasoningMaxTokens");
const modelThinkingTypeInput = document.getElementById("modelThinkingType");
const modelHeadersInput = document.getElementById("modelHeaders");
const modelExtraInput = document.getElementById("modelExtra");
const saveModelBtn = document.getElementById("saveModel");
const cancelModelBtn = document.getElementById("cancelModel");
const toggleAdvancedSettingsBtn = document.getElementById("toggleAdvancedSettings");
const commitModelInput = document.getElementById("commitModel");
const commitLanguageInput = document.getElementById("commitLanguage");
const advancedSettingsContent = document.getElementById("advancedSettingsContent");

// Error message element
const modelErrorElement = document.getElementById("modelError");

// Dropdown elements
const dropdownContent = modelIdDropdown.querySelector(".dropdown-content");
const dropdownHeader = modelIdDropdown.querySelector(".dropdown-header");

// Global Configuration save button event listener
document.getElementById("saveBase").addEventListener("click", () => {
	const retry = {
		enabled: retryEnabledInput.checked,
		max_attempts: parseInt(maxAttemptsInput.value) || 3,
		interval_ms: parseInt(intervalMsInput.value) || 1000,
		status_codes: statusCodesInput.value
			? statusCodesInput.value
					.split(",")
					.map((s) => parseInt(s.trim()))
					.filter((n) => !isNaN(n))
			: [],
	};

	vscode.postMessage({
		type: "saveGlobalConfig",
		baseUrl: baseUrlInput.value,
		apiKey: apiKeyInput.value,
		delay: parseInt(delayInput.value) || 0,
		readFileLines: parseInt(readFileLinesInput.value) || 0,
		retry: retry,
		commitModel: commitModelInput.value,
		commitLanguage: commitLanguageInput.value,
	});
});

const handleRefresh = () => {
	// Hide the model form if it's visible
	if (modelFormSection.style.display !== "none") {
		modelFormSection.style.display = "none";
		resetModelForm();
	}
	vscode.postMessage({ type: "requestInit" });
};

// Subscription operations run in the extension host. OAuth tokens never enter the webview.
function runChatGPTAction(type) {
	chatgptStatus.textContent = type === "chatgptSignIn" ? "Waiting for browser authorization…" : "Updating…";
	chatgptSignInBtn.disabled = true;
	chatgptSignOutBtn.disabled = true;
	chatgptRefreshBtn.disabled = true;
	vscode.postMessage({ type });
}

chatgptSignInBtn.addEventListener("click", () => runChatGPTAction("chatgptSignIn"));
chatgptSignOutBtn.addEventListener("click", () => runChatGPTAction("chatgptSignOut"));
chatgptRefreshBtn.addEventListener("click", () => runChatGPTAction("chatgptRefresh"));

function renderChatGPTStatus() {
	const connected = state.chatgptConnected;
	chatgptStatus.textContent = connected ? "Signed in" : "Not signed in";
	chatgptStatus.classList.toggle("connected", connected);
	chatgptSignInBtn.textContent = connected ? "Sign in with another account" : "Sign in to ChatGPT";
	chatgptSignInBtn.disabled = false;
	chatgptSignOutBtn.disabled = !connected;
	chatgptRefreshBtn.disabled = !connected;
	chatgptSummary.textContent = connected
		? state.discoveredModels.length
			? `${state.discoveredModels.length} models discovered. Model settings from Codex can be overridden individually below.`
			: "Credentials are saved, but no models were discovered. Try Refresh Models or check the OAICopilot logs."
		: "Sign in to discover subscription models. Other API key providers are unaffected.";
}

function escapeHtml(value) {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character]
	);
}

function modelKey(model) {
	return model.id + (model.configId ? "::" + model.configId : "");
}

function isDiscoveredChatGPTModel(model) {
	return (
		model.chatgptAuth === true &&
		model.configId === "chatgpt" &&
		state.discoveredModels.some((entry) => entry.id === model.id)
	);
}

function hasChatGPTOverride(model) {
	return state.manualModels.some(
		(entry) => entry.id === model.id && entry.chatgptAuth === true && (!entry.configId || entry.configId === "chatgpt")
	);
}

// Export and Import buttons event listeners
document.getElementById("exportConfig").addEventListener("click", () => {
	vscode.postMessage({ type: "exportConfig" });
});

document.getElementById("importConfig").addEventListener("click", () => {
	vscode.postMessage({ type: "importConfig" });
});

// Refresh buttons event listeners
document.getElementById("refreshGlobalConfig").addEventListener("click", handleRefresh);
document.getElementById("refreshProviders").addEventListener("click", handleRefresh);
document.getElementById("refreshModels").addEventListener("click", handleRefresh);

// Add Provider button event listener
document.getElementById("addProvider").addEventListener("click", () => {
	// Add new provider row to the table
	const newRow = document.createElement("tr");
	newRow.innerHTML = `
		<td><input type="text" class="provider-input" data-field="provider" placeholder="Provider ID" /></td>
		<td><input type="checkbox" class="provider-input" data-field="enabled" checked /></td>
		<td><input type="text" class="provider-input" data-field="baseUrl" placeholder="Base URL" /></td>
		<td><input type="password" class="provider-input" data-field="apiKey" placeholder="API Key" /></td>
		<td>
			<select class="provider-input" data-field="apiMode">
				<option value="openai">OpenAI</option>
				<option value="openai-responses">OpenAI Responses</option>
				<option value="ollama">Ollama</option>
				<option value="anthropic">Anthropic</option>
				<option value="gemini">Gemini</option>
			</select>
		</td>
		<td><textarea class="provider-input" data-field="headers" rows="2" placeholder='{"X-API-Version": "v1"}' style="width: 100%; font-family: monospace; font-size: 12px;"></textarea></td>
		<td>
			<button class="save-provider-btn secondary">Save</button>
			<button class="cancel-provider-btn secondary">Cancel</button>
		</td>
	`;
	providerTableBody.appendChild(newRow);

	// Add event listeners for the new row
	const saveBtn = newRow.querySelector(".save-provider-btn");
	const cancelBtn = newRow.querySelector(".cancel-provider-btn");

	saveBtn.addEventListener("click", () => {
		const inputs = newRow.querySelectorAll(".provider-input");
		const providerData = {};
		inputs.forEach((input) => {
			const field = input.getAttribute("data-field");
			providerData[field] = input.type === "checkbox" ? input.checked : input.value;
		});

		let headers = undefined;
		if (providerData.headers && providerData.headers.trim()) {
			try {
				headers = JSON.parse(providerData.headers);
			} catch (e) {
				// ignore invalid JSON
			}
		}

		vscode.postMessage({
			type: "addProvider",
			provider: providerData.provider,
			baseUrl: providerData.baseUrl || undefined,
			apiKey: providerData.apiKey || undefined,
			apiMode: providerData.apiMode || undefined,
			headers: headers,
			enabled: providerData.enabled,
		});

		newRow.remove();
	});

	cancelBtn.addEventListener("click", () => {
		newRow.remove();
	});
});

// Add Model button event listeners
document.getElementById("addModel").addEventListener("click", () => {
	// Show the model form
	modelFormSection.style.display = "block";
	modelFormTitle.textContent = "Add New Model";
	// Reset form
	resetModelForm();
});

// Provider dropdown change event listener for auto-fill
modelProviderInput.addEventListener("change", () => {
	const selectedProvider = modelProviderInput.value;
	if (selectedProvider === "chatgpt") {
		modelChatGPTAuthInput.checked = true;
		modelApiModeInput.value = "openai-responses";
		modelBaseUrlInput.value = "";
		modelHeadersInput.value = "";
		if (!modelIdInput.hasAttribute("data-editing")) {
			modelConfigIdInput.value = "chatgpt";
			modelContextLengthInput.value = "";
			modelMaxTokensInput.value = "";
			modelTemperatureInput.value = "";
		}
		populateModelIdDropdown(state.discoveredModels);
		return;
	}
	modelChatGPTAuthInput.checked = false;
	if (selectedProvider && state.providerInfo[selectedProvider]) {
		// Auto-fill BaseURL and apiMode from provider info
		modelBaseUrlInput.value = state.providerInfo[selectedProvider].baseUrl;
		modelApiModeInput.value = state.providerInfo[selectedProvider].apiMode;

		// Use headers from provider info
		const headers = state.providerInfo[selectedProvider].headers;
		modelHeadersInput.value = headers ? JSON.stringify(headers, null, 2) : "";

		// Request to fetch remote models for the selected provider
		vscode.postMessage({
			type: "fetchModels",
			baseUrl: state.providerInfo[selectedProvider].baseUrl || state.baseUrl,
			apiKey: state.providerKeys[selectedProvider] || state.apiKey,
			apiMode: state.providerInfo[selectedProvider].apiMode || modelApiModeInput.value || "openai",
			headers,
		});
	}
});

modelChatGPTAuthInput.addEventListener("change", () => {
	if (modelChatGPTAuthInput.checked) {
		modelApiModeInput.value = "openai-responses";
		modelBaseUrlInput.value = "";
		if (!modelIdInput.hasAttribute("data-editing")) {
			modelConfigIdInput.value ||= "chatgpt";
			modelContextLengthInput.value = "";
			modelMaxTokensInput.value = "";
			modelTemperatureInput.value = "";
		}
	}
});

// Toggle advanced settings
toggleAdvancedSettingsBtn.addEventListener("click", () => {
	const isCurrentlyVisible = advancedSettingsContent.style.display !== "none";
	advancedSettingsContent.style.display = isCurrentlyVisible ? "none" : "block";
	toggleAdvancedSettingsBtn.textContent = isCurrentlyVisible ? "Show Advanced Settings" : "Hide Advanced Settings";
});

// Save Model button event listener
saveModelBtn.addEventListener("click", () => {
	const modelData = collectModelFormData();
	if (!validateModelData(modelData)) {
		return;
	}

	// For updates, ensure the model ID remains unchanged
	const isEditing = modelIdInput.hasAttribute("data-editing");
	if (isEditing) {
		// Remove helper attributes from the model data before sending
		let originalModelId = modelData.originalModelId;
		let originalConfigId = modelData.originalConfigId;
		delete modelData.originalModelId;
		delete modelData.originalConfigId;

		vscode.postMessage({
			type: "updateModel",
			model: modelData,
			originalModelId: originalModelId,
			originalConfigId: originalConfigId,
		});
	} else {
		vscode.postMessage({
			type: "addModel",
			model: modelData,
		});
	}

	// Hide the form and reset it
	modelFormSection.style.display = "none";
	resetModelForm();
});

// Cancel Model button event listener
cancelModelBtn.addEventListener("click", () => {
	// Hide the form and reset it
	modelFormSection.style.display = "none";
	resetModelForm();
});

window.addEventListener("message", (event) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			const {
				baseUrl,
				apiKey,
				delay,
				readFileLines,
				retry,
				commitModel,
				models,
				manualModels,
				discoveredModels,
				chatgptConnected,
				disabledProviders,
				hiddenProviders,
				providerKeys,
				commitLanguage,
			} = message.payload;
			state.baseUrl = baseUrl;
			state.apiKey = apiKey;
			state.delay = delay || 0;
			state.readFileLines = readFileLines || 0;
			state.retry = retry || {
				enabled: true,
				max_attempts: 3,
				interval_ms: 1000,
				status_codes: [],
			};
			state.models = models || [];
			state.manualModels = manualModels || [];
			state.discoveredModels = discoveredModels || [];
			state.chatgptConnected = chatgptConnected === true;
			state.disabledProviders = disabledProviders || [];
			state.hiddenProviders = hiddenProviders || [];
			state.commitModel = commitModel || "";
			state.providerKeys = providerKeys || {};

			// Update base configuration
			baseUrlInput.value = baseUrl || "";
			apiKeyInput.value = apiKey || "";
			delayInput.value = state.delay;
			readFileLinesInput.value = message.payload.readFileLines || 0;
			retryEnabledInput.checked = state.retry.enabled !== false;
			maxAttemptsInput.value = state.retry.max_attempts || 3;
			intervalMsInput.value = state.retry.interval_ms || 1000;
			statusCodesInput.value = state.retry.status_codes ? state.retry.status_codes.join(",") : "";

			// Populate commit model dropdown and select current commit model
			populateCommitModelDropdown();
			commitModelInput.value = state.commitModel || "";
			commitLanguageInput.value = commitLanguage;

			// Render subscription, provider, and model management
			renderChatGPTStatus();
			renderProviders();
			renderModels();
			break;
		case "modelsFetched":
			// Handle the response from fetchModels
			populateModelIdDropdown(message.models);
			break;
		case "modelsFetchError":
			// Handle error from fetchModels
			dropdownHeader.textContent = "Error fetching models";
			dropdownContent.innerHTML = `<div class="dropdown-option error">Failed to fetch models. Check the Developer Console for details.</div>`;
			console.error("[oaicopilot] Failed to fetch models:", message.error);
			break;
		case "confirmResponse":
			// Handle confirmation responses
			const pendingAction = pendingConfirmations.get(message.id);
			if (pendingAction && message.confirmed) {
				if (pendingAction.action) {
					pendingAction.action();
				}
				// Clean up the pending confirmation
				pendingConfirmations.delete(message.id);
			} else if (pendingAction) {
				// Clean up the pending confirmation even if not confirmed
				pendingConfirmations.delete(message.id);
			}
			break;
	}
});

function renderProviders() {
	// Capture any unsaved edits from the currently rendered rows before we rebuild the DOM,
	// so that rows the user hasn't saved yet don't lose their pending changes when another
	// provider row is saved (which triggers a full sendInit()/renderProviders() refresh).
	const pendingEdits = captureUnsavedProviderEdits();

	// Get all unique providers
	const providers = Array.from(
		new Set(
			state.manualModels
				.filter((m) => !m.chatgptAuth)
				.map((m) => m.owned_by)
				.filter(Boolean)
		)
	);
	const sortedProviders = sortRows(providers, "providerTable", providerSortValue, (provider) => provider);
	renderSortIndicators("providerTable");

	if (!providers.length) {
		providerTableBody.innerHTML = '<tr><td colspan="8" class="no-data">No providers</td></tr>';
		// Clear the provider dropdown as well
		modelProviderInput.innerHTML =
			'<option value="">Select Provider</option>' + '<option value="chatgpt">chatgpt (subscription)</option>';
		state.providerInfo = {};
		return;
	}

	const rows = sortedProviders
		.map((provider) => {
			// Get the provider's configuration information
			const providerModels = state.manualModels.filter((m) => m.owned_by === provider && !m.chatgptAuth);
			const firstModel = providerModels[0];
			const providerEnabled = !state.disabledProviders.some((item) => item.toLowerCase() === provider.toLowerCase());
			const providerHidden = state.hiddenProviders.some((item) => item.toLowerCase() === provider.toLowerCase());
			const headersJson = firstModel.headers ? JSON.stringify(firstModel.headers, null, 2) : "";

			return `
			<tr data-provider="${provider}">
				<td><input type="text" class="provider-input" data-field="provider" data-original-provider="${provider}" value="${provider}" placeholder="Provider ID" /></td>
				<td><input type="checkbox" class="provider-input" data-field="enabled" ${providerEnabled ? "checked" : ""} /></td>
				<td><input type="checkbox" class="provider-input" data-field="hidden" ${providerHidden ? "checked" : ""} title="Hide this provider's models in Model Management" /></td>
				<td><input type="text" class="provider-input" data-field="baseUrl" value="${firstModel.baseUrl || ""}" placeholder="Base URL" /></td>
				<td><input type="password" class="provider-input" data-field="apiKey" value="${state.providerKeys[provider] || ""}" placeholder="API Key" /></td>
				<td>
					<select class="provider-input" data-field="apiMode">
						<option value="openai" ${firstModel.apiMode === "openai" ? "selected" : ""}>OpenAI</option>
						<option value="openai-responses" ${firstModel.apiMode === "openai-responses" ? "selected" : ""}>OpenAI Responses</option>
						<option value="ollama" ${firstModel.apiMode === "ollama" ? "selected" : ""}>Ollama</option>
						<option value="anthropic" ${firstModel.apiMode === "anthropic" ? "selected" : ""}>Anthropic</option>
						<option value="gemini" ${firstModel.apiMode === "gemini" ? "selected" : ""}>Gemini</option>
					</select>
				</td>
				<td><textarea class="provider-input" data-field="headers" rows="2" placeholder='{"X-API-Version": "v1"}' style="width: 100%; font-family: monospace; font-size: 12px;">${headersJson}</textarea></td>
				<td class="action-buttons">
					<button class="update-provider-btn" data-provider="${provider}" disabled>Save</button>
					<button class="delete-provider-btn danger" data-provider="${provider}" title="Delete">🗑️</button>
				</td>
			</tr>`;
		})
		.join("");

	providerTableBody.innerHTML = rows;

	// Populate the provider dropdown in the model form and provider info
	state.providerInfo = {}; // Reset provider info
	const providerOptions = providers
		.map((provider) => {
			// Get the provider's configuration information
			const providerModels = state.manualModels.filter((m) => m.owned_by === provider && !m.chatgptAuth);
			const firstModel = providerModels[0];

			// Store provider info for auto-fill
			state.providerInfo[provider] = {
				baseUrl: firstModel.baseUrl || state.baseUrl,
				apiMode: firstModel.apiMode || "openai",
				apiKey: state.providerKeys[provider] || state.apiKey,
				headers: firstModel.headers,
			};

			return `<option value="${provider}">${provider}</option>`;
		})
		.join("");
	modelProviderInput.innerHTML =
		'<option value="">Select Provider</option>' +
		'<option value="chatgpt">chatgpt (subscription)</option>' +
		providerOptions;

	// Restore any unsaved edits captured before this rebuild.
	restoreUnsavedProviderEdits(pendingEdits);

	providerTableBody.querySelectorAll("tr[data-provider]").forEach((row) => {
		const saveButton = row.querySelector(".update-provider-btn");
		const savedValue = getProviderRowValue(row);
		row.querySelectorAll(".provider-input").forEach((input) => {
			const eventName = input.type === "checkbox" || input.tagName === "SELECT" ? "change" : "input";
			input.addEventListener(eventName, () => {
				saveButton.disabled = getProviderRowValue(row) === savedValue;
			});
		});
	});

	// Add event listeners for provider rows
	document.querySelectorAll(".update-provider-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const originalProvider = event.target.getAttribute("data-provider");
			const row = event.target.closest("tr");
			const inputs = row.querySelectorAll(".provider-input");
			const providerData = {};
			inputs.forEach((input) => {
				const field = input.getAttribute("data-field");
				providerData[field] = input.type === "checkbox" ? input.checked : input.value;
			});

			const newProvider = (providerData.provider || "").trim();
			if (!newProvider) {
				alert("Provider ID is required.");
				return;
			}

			let headers = undefined;
			if (providerData.headers && providerData.headers.trim()) {
				try {
					headers = JSON.parse(providerData.headers);
				} catch (e) {
					// ignore invalid JSON
				}
			}

			vscode.postMessage({
				type: "updateProvider",
				provider: newProvider,
				originalProvider: originalProvider,
				baseUrl: providerData.baseUrl || undefined,
				apiKey: providerData.apiKey || undefined,
				apiMode: providerData.apiMode || undefined,
				headers: headers,
				enabled: providerData.enabled,
				hidden: providerData.hidden,
			});

			// Mark this row as saved immediately so the pending sendInit()/renderProviders()
			// refresh doesn't mistake it for a still-dirty row and restore its stale pre-save values.
			event.target.disabled = true;
		});
	});

	document.querySelectorAll(".delete-provider-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const provider = event.target.getAttribute("data-provider");
			const confirmId = "deleteProvider_" + Date.now();

			// Store the action to be performed after confirmation
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteProvider", provider: provider }),
			});

			vscode.postMessage({
				type: "requestConfirm",
				id: confirmId,
				message: `Are you sure you want to delete provider ${provider} and all its models?`,
				action: "deleteProvider",
			});
		});
	});
}

function getProviderRowValue(row) {
	return JSON.stringify(
		Array.from(row.querySelectorAll(".provider-input")).map((input) => [
			input.getAttribute("data-field"),
			input.type === "checkbox" ? input.checked : input.value,
		])
	);
}

// Snapshot every currently-rendered provider row's live field values, keyed by the
// row's *original* provider id (data-original-provider), before a full re-render wipes them out.
// Only rows whose Save button is enabled (i.e. actually dirty) are kept, so freshly-saved
// or untouched rows are rebuilt cleanly from the latest server state.
function captureUnsavedProviderEdits() {
	const edits = {};
	providerTableBody.querySelectorAll("tr[data-provider]").forEach((row) => {
		const saveButton = row.querySelector(".update-provider-btn");
		if (!saveButton || saveButton.disabled) {
			return;
		}
		const originalProvider = row.querySelector('[data-field="provider"]')?.getAttribute("data-original-provider");
		if (!originalProvider) {
			return;
		}
		const values = {};
		row.querySelectorAll(".provider-input").forEach((input) => {
			const field = input.getAttribute("data-field");
			values[field] = input.type === "checkbox" ? input.checked : input.value;
		});
		edits[originalProvider] = values;
	});
	return edits;
}

// Re-apply captured unsaved edits to the freshly-rendered rows, and mark their Save
// button as dirty again so the user's in-progress work on the *other* provider row
// survives a save-triggered refresh.
function restoreUnsavedProviderEdits(pendingEdits) {
	Object.keys(pendingEdits).forEach((originalProvider) => {
		const providerInput = providerTableBody.querySelector(
			`[data-field="provider"][data-original-provider="${originalProvider}"]`
		);
		const row = providerInput ? providerInput.closest("tr") : null;
		if (!row) {
			return;
		}
		const values = pendingEdits[originalProvider];
		row.querySelectorAll(".provider-input").forEach((input) => {
			const field = input.getAttribute("data-field");
			if (!(field in values)) {
				return;
			}
			if (input.type === "checkbox") {
				input.checked = values[field];
			} else {
				input.value = values[field];
			}
		});
		const saveButton = row.querySelector(".update-provider-btn");
		if (saveButton) {
			saveButton.disabled = false;
		}
	});
}

function renderModels() {
	// Hide models of providers marked hidden.
	const models = state.models.filter(
		(m) =>
			!m.id.startsWith("__provider__") &&
			!state.hiddenProviders.some((item) => item.toLowerCase() === (m.owned_by || "").toLowerCase())
	);
	const sortedModels = sortRows(models, "modelTable", modelSortValue, (model) => modelKey(model));
	renderSortIndicators("modelTable");
	if (!models.length) {
		modelTableBody.innerHTML = '<tr><td colspan="14" class="no-data">No models</td></tr>';
		return;
	}

	const rows = sortedModels
		.map((model) => {
			const providerDisabled = state.disabledProviders.some(
				(item) => item.toLowerCase() === (model.owned_by || "").toLowerCase()
			);
			const key = escapeHtml(modelKey(model));
			const auto = isDiscoveredChatGPTModel(model);
			const hasOverride = auto && hasChatGPTOverride(model);
			const authLabel = model.chatgptAuth
				? auto
					? hasOverride
						? "ChatGPT · Override"
						: "ChatGPT · Auto"
					: "ChatGPT · Manual"
				: "API Key";
			const action = auto
				? hasOverride
					? `<button class="reset-chatgpt-model-btn secondary" data-model-id="${key}" title="Remove the override and restore Codex defaults">Reset</button>`
					: ""
				: `<button class="delete-model-btn danger" data-model-id="${key}" title="Delete">🗑️</button>`;
			return `
			<tr data-model-id="${key}"${providerDisabled ? ' class="model-provider-disabled"' : ""}>
				<td>${escapeHtml(model.id)}</td>
				<td><input type="checkbox" class="model-enabled-toggle" data-model-id="${key}" ${model.enabled !== false ? "checked" : ""} /></td>
				<td>${escapeHtml(model.owned_by)}</td>
				<td><span class="auth-label">${escapeHtml(authLabel)}</span></td>
				<td>${escapeHtml(model.displayName)}</td>
				<td>${escapeHtml(model.configId)}</td>
				<td>${escapeHtml(model.context_length)}</td>
				<td>${escapeHtml(model.max_completion_tokens ?? model.max_tokens ?? model.catalog_max_output_tokens ?? "")}</td>
				<td>${model.vision ? "True" : ""}</td>
				<td>${escapeHtml(model.temperature !== undefined && model.temperature !== null ? model.temperature : "")}</td>
				<td>${escapeHtml(model.top_p !== undefined && model.top_p !== null ? model.top_p : "")}</td>
				<td>${escapeHtml(model.delay || "")}</td>
				<td>${model.pricing ? `$${escapeHtml(model.pricing.input)} / $${escapeHtml(model.pricing.output)}` : ""}</td>
				<td class="action-buttons">
					<button class="update-model-btn" data-model-id="${key}">Edit</button>
					${action}
				</td>
			</tr>`;
		})
		.join("");

	modelTableBody.innerHTML = rows;

	document.querySelectorAll(".model-enabled-toggle").forEach((toggle) => {
		toggle.addEventListener("change", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			const model = findModel(modelId);
			if (model) {
				vscode.postMessage({
					type: "updateModel",
					model: { ...model, enabled: event.target.checked },
					originalModelId: model.id,
					originalConfigId: model.configId,
				});
			}
		});
	});

	// Auto-discovered entries cannot be deleted: reset their manual override instead.
	modelTableBody.querySelectorAll(".reset-chatgpt-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.currentTarget.getAttribute("data-model-id");
			const model = findModel(modelId);
			if (!model || !isDiscoveredChatGPTModel(model)) {
				return;
			}
			const confirmId = "resetChatGPT_" + Date.now();
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "resetChatGPTOverride", modelId: model.id }),
			});
			vscode.postMessage({
				type: "requestConfirm",
				id: confirmId,
				message: `Remove manual settings for ${model.id} and restore the discovered Codex defaults?`,
				action: "resetChatGPTOverride",
			});
		});
	});

	// Add event listeners for model rows
	document.querySelectorAll(".update-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			// Find the model in state
			const parsedModelId = modelId.includes("::")
				? { baseId: modelId.split("::")[0], configId: modelId.split("::")[1] }
				: { baseId: modelId, configId: null };

			const model = state.models.find(
				(m) =>
					m.id === parsedModelId.baseId &&
					((parsedModelId.configId && m.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !m.configId))
			);

			if (model) {
				// Show the model form in edit mode
				modelFormSection.style.display = "block";
				modelFormTitle.textContent = isDiscoveredChatGPTModel(model)
					? `Override ChatGPT Model: ${modelId}`
					: `Edit Model: ${modelId}`;
				populateModelForm(model);
			}
		});
	});

	document.querySelectorAll(".delete-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			const confirmId = "deleteModel_" + Date.now();

			// Store the action to be performed after confirmation
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteModel", modelId: modelId }),
			});

			vscode.postMessage({
				type: "requestConfirm",
				id: confirmId,
				message: `Are you sure you want to delete model ${modelId}?`,
				action: "deleteModel",
			});
		});
	});
}

function findModel(modelId) {
	const separatorIndex = modelId.indexOf("::");
	const baseId = separatorIndex === -1 ? modelId : modelId.slice(0, separatorIndex);
	const configId = separatorIndex === -1 ? undefined : modelId.slice(separatorIndex + 2);
	return state.models.find(
		(model) => model.id === baseId && (configId ? model.configId === configId : !model.configId)
	);
}

// Reset model form
function resetModelForm() {
	// Clear any error message
	showModelError("");

	modelIdInput.value = "";
	modelProviderInput.value = "";
	modelEnabledInput.checked = true;
	modelDisplayNameInput.value = "";
	modelConfigIdInput.value = "";
	modelBaseUrlInput.value = "";
	modelFamilyInput.value = "";
	modelContextLengthInput.value = 128000;
	modelMaxTokensInput.value = 4096;
	modelVisionInput.value = "";
	modelApiModeInput.value = "openai";
	modelChatGPTAuthInput.checked = false;
	modelChatGPTAuthInput.disabled = false;
	modelTemperatureInput.value = 0;
	modelTopPInput.value = "";
	modelDelayInput.value = "";
	modelPriceInputInput.value = "";
	modelPriceOutputInput.value = "";
	modelPriceCacheReadInput.value = "";
	modelPriceCacheWriteInput.value = "";
	modelTopKInput.value = "";
	modelMinPInput.value = "";
	modelFrequencyPenaltyInput.value = "";
	modelPresencePenaltyInput.value = "";
	modelRepetitionPenaltyInput.value = "";
	modelReasoningEffortInput.replaceChildren(
		...["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
			(effort) => new Option(effort || "Default", effort)
		)
	);
	modelReasoningEffortInput.value = "";
	modelEnableThinkingInput.value = "";
	modelThinkingBudgetInput.value = "";
	modelIncludeReasoningInput.value = "";
	modelMaxCompletionTokensInput.value = "";
	modelReasoningEnabledInput.value = "";
	modelReasoningExcludeInput.value = "";
	modelReasoningEffortORInput.value = "";
	modelReasoningMaxTokensInput.value = "";
	modelThinkingTypeInput.value = "";
	modelHeadersInput.value = "";
	modelExtraInput.value = "";
	advancedSettingsContent.style.display = "none";
	toggleAdvancedSettingsBtn.textContent = "Show Advanced Settings";
	// Remove editing attribute
	modelIdInput.removeAttribute("data-editing");
	modelIdInput.removeAttribute("data-original-id");
	modelIdInput.removeAttribute("data-original-configId");
	// disbale fields when form is reset
	modelBaseUrlInput.disabled = true;
	modelApiModeInput.disabled = true;
	modelProviderInput.disabled = false;
	modelConfigIdInput.disabled = false;
	// Clear dropdown options
	dropdownContent.innerHTML = "";
}

// Collect model form data
function collectModelFormData() {
	const isEditing = modelIdInput.hasAttribute("data-editing");

	return {
		id: modelIdInput.value.trim(),
		owned_by: modelChatGPTAuthInput.checked ? "chatgpt" : modelProviderInput.value.trim(),
		enabled: modelEnabledInput.checked,
		displayName: modelDisplayNameInput.value.trim() || undefined,
		configId: modelConfigIdInput.value.trim() || undefined,
		baseUrl: modelBaseUrlInput.value.trim() || undefined,
		family: modelFamilyInput.value.trim() || undefined,
		context_length: modelContextLengthInput.value ? parseInt(modelContextLengthInput.value) : undefined,
		max_tokens: modelMaxTokensInput.value ? parseInt(modelMaxTokensInput.value) : undefined,
		vision: modelVisionInput.value ? modelVisionInput.value === "true" : undefined,
		apiMode: modelChatGPTAuthInput.checked ? "openai-responses" : modelApiModeInput.value || undefined,
		chatgptAuth: modelChatGPTAuthInput.checked || undefined,
		temperature: modelTemperatureInput.value !== "" ? parseFloat(modelTemperatureInput.value) : undefined,
		top_p: modelTopPInput.value !== "" ? parseFloat(modelTopPInput.value) : undefined,
		delay: modelDelayInput.value ? parseInt(modelDelayInput.value) : undefined,
		pricing: buildPricingConfig(),
		top_k: modelTopKInput.value ? parseInt(modelTopKInput.value) : undefined,
		min_p: modelMinPInput.value !== "" ? parseFloat(modelMinPInput.value) : undefined,
		frequency_penalty:
			modelFrequencyPenaltyInput.value !== "" ? parseFloat(modelFrequencyPenaltyInput.value) : undefined,
		presence_penalty: modelPresencePenaltyInput.value !== "" ? parseFloat(modelPresencePenaltyInput.value) : undefined,
		repetition_penalty:
			modelRepetitionPenaltyInput.value !== "" ? parseFloat(modelRepetitionPenaltyInput.value) : undefined,
		reasoning_effort: modelReasoningEffortInput.value || undefined,
		enable_thinking: modelEnableThinkingInput.value ? modelEnableThinkingInput.value === "true" : undefined,
		thinking_budget: modelThinkingBudgetInput.value ? parseInt(modelThinkingBudgetInput.value) : undefined,
		include_reasoning_in_request: modelIncludeReasoningInput.value
			? modelIncludeReasoningInput.value === "true"
			: undefined,
		max_completion_tokens: modelMaxCompletionTokensInput.value
			? parseInt(modelMaxCompletionTokensInput.value)
			: undefined,
		// Build reasoning configuration object
		reasoning: buildReasoningConfig(),
		// Build thinking configuration object
		thinking: buildThinkingConfig(),
		// Parse headers and extra JSON
		headers: parseJsonField(modelHeadersInput.value),
		extra: parseJsonField(modelExtraInput.value),
		// Include original modelId and configId for update operations
		originalModelId: isEditing ? modelIdInput.getAttribute("data-original-id") : undefined,
		originalConfigId: isEditing ? modelIdInput.getAttribute("data-original-configId") : undefined,
	};
}

// Build reasoning configuration object from form fields
function buildReasoningConfig() {
	const enabled = modelReasoningEnabledInput.value ? modelReasoningEnabledInput.value === "true" : undefined;
	const effort = modelReasoningEffortORInput.value || undefined;
	const exclude = modelReasoningExcludeInput.value ? modelReasoningExcludeInput.value === "true" : undefined;
	const maxTokens = modelReasoningMaxTokensInput.value ? parseInt(modelReasoningMaxTokensInput.value) : undefined;

	// Only return an object if at least one field has a value
	if (enabled !== undefined || effort !== undefined || exclude !== undefined || maxTokens !== undefined) {
		return {
			enabled,
			effort,
			exclude,
			max_tokens: maxTokens,
		};
	}
	return undefined;
}

// Build thinking configuration object from form fields
function buildThinkingConfig() {
	const type = modelThinkingTypeInput.value || undefined;

	if (type !== undefined) {
		return { type };
	}
	return undefined;
}

// Build pricing configuration object from form fields
function buildPricingConfig() {
	const input = modelPriceInputInput.value !== "" ? parseFloat(modelPriceInputInput.value) : undefined;
	const output = modelPriceOutputInput.value !== "" ? parseFloat(modelPriceOutputInput.value) : undefined;
	const cacheRead = modelPriceCacheReadInput.value !== "" ? parseFloat(modelPriceCacheReadInput.value) : undefined;
	const cacheWrite = modelPriceCacheWriteInput.value !== "" ? parseFloat(modelPriceCacheWriteInput.value) : undefined;

	// Pricing is only meaningful when both input and output prices are set.
	if (input !== undefined && output !== undefined) {
		return {
			input,
			output,
			cache_read: cacheRead,
			cache_write: cacheWrite,
		};
	}
	return undefined;
}

// Parse JSON field, return undefined if empty or invalid
function parseJsonField(value) {
	if (!value || value.trim() === "") {
		return undefined;
	}
	try {
		return JSON.parse(value.trim());
	} catch (error) {
		// ignore invalid JSON
		return undefined;
	}
}

// Show error message in the UI
function showModelError(message) {
	if (modelErrorElement) {
		modelErrorElement.textContent = message;
		modelErrorElement.style.display = message ? "block" : "none";

		// Scroll to error message if it's visible
		if (message) {
			modelErrorElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}
}

// Validate model data
function validateModelData(modelData) {
	// Clear any previous error
	showModelError("");

	if (!modelData.id) {
		showModelError("Model ID is required.");
		return false;
	}
	if (!modelData.owned_by) {
		showModelError("Provider ID is required.");
		return false;
	}

	// Validate modelId and configId Uniqueness
	const isEditing = modelIdInput.hasAttribute("data-editing");
	const hasDuplicate = state.models
		.filter((m) => {
			if (isEditing) {
				const isOrigin =
					m.id === modelData.originalModelId &&
					((modelData.originalConfigId && m.configId === modelData.originalConfigId) ||
						(!modelData.originalConfigId && !m.configId));
				return !isOrigin;
			}
			return true;
		})
		.some((m) => {
			return (
				m.id === modelData.id &&
				((modelData.configId && m.configId === modelData.configId) || (!modelData.configId && !m.configId))
			);
		});

	if (hasDuplicate) {
		showModelError(
			`A model with ID="${modelData.id}"${
				modelData.configId ? ` and Config ID="${modelData.configId}"` : ""
			} already exists. Model ID and Config ID combination must be unique.`
		);
		return false;
	}

	// Validate numeric fields if provided
	if (modelData.context_length !== undefined && (isNaN(modelData.context_length) || modelData.context_length <= 0)) {
		showModelError("Context Length must be a positive number.");
		return false;
	}
	if (modelData.max_tokens !== undefined && (isNaN(modelData.max_tokens) || modelData.max_tokens <= 0)) {
		showModelError("Max Tokens must be a positive number.");
		return false;
	}
	if (
		modelData.max_completion_tokens !== undefined &&
		(isNaN(modelData.max_completion_tokens) || modelData.max_completion_tokens <= 0)
	) {
		showModelError("Max Completion Tokens must be a positive number.");
		return false;
	}
	// Prevent both max_tokens and max_completion_tokens from being set simultaneously
	if (modelData.max_tokens !== undefined && modelData.max_completion_tokens !== undefined) {
		showModelError("Cannot set both 'max_tokens' and 'max_completion_tokens'. Use 'max_completion_tokens' only.");
		return false;
	}
	if (
		modelData.temperature !== undefined &&
		(isNaN(modelData.temperature) || modelData.temperature < 0 || modelData.temperature > 2)
	) {
		showModelError("Temperature must be between 0 and 2.");
		return false;
	}
	if (modelData.top_p !== undefined && (isNaN(modelData.top_p) || modelData.top_p < 0 || modelData.top_p > 1)) {
		showModelError("Top P must be between 0 and 1.");
		return false;
	}
	if (modelData.pricing !== undefined) {
		const { input, output, cache_read: cacheRead, cache_write: cacheWrite } = modelData.pricing;
		if (isNaN(input) || input < 0) {
			showModelError("Input Price must be a non-negative number.");
			return false;
		}
		if (isNaN(output) || output < 0) {
			showModelError("Output Price must be a non-negative number.");
			return false;
		}
		if (cacheRead !== undefined && (isNaN(cacheRead) || cacheRead < 0)) {
			showModelError("Cache Read Price must be a non-negative number.");
			return false;
		}
		if (cacheWrite !== undefined && (isNaN(cacheWrite) || cacheWrite < 0)) {
			showModelError("Cache Write Price must be a non-negative number.");
			return false;
		}
	}
	if (modelData.delay !== undefined && (isNaN(modelData.delay) || modelData.delay < 0)) {
		showModelError("Delay must be a non-negative number.");
		return false;
	}

	// Validate JSON fields
	if (modelData.headers && typeof modelData.headers !== "object") {
		showModelError("Custom Headers must be a valid JSON object.");
		return false;
	}
	if (modelData.extra && typeof modelData.extra !== "object") {
		showModelError("Extra Parameters must be a valid JSON object.");
		return false;
	}

	return true;
}

// Function to populate the model ID datalist
function populateModelIdDropdown(models) {
	const modelsArray = Array.from(models || []);

	// Clear existing options
	dropdownContent.innerHTML = "";

	if (!modelsArray.length) {
		dropdownHeader.textContent = "No models available";
		return;
	}

	dropdownHeader.textContent = `Select Model (${modelsArray.length} available)`;

	// Create option elements
	modelsArray.forEach((model) => {
		const option = document.createElement("div");
		option.className = "dropdown-option";
		option.textContent = model.id;
		option.dataset.modelId = model.id;

		// Add click event
		option.addEventListener("click", () => {
			modelIdInput.value = model.id;
			hideDropdown();

			// Remove selection from all options
			dropdownContent.querySelectorAll(".dropdown-option").forEach((opt) => {
				opt.classList.remove("selected");
			});

			// Add selection to clicked option
			option.classList.add("selected");
		});

		dropdownContent.appendChild(option);
	});
}

// Function to populate the commit model dropdown
function populateCommitModelDropdown() {
	// Clear existing options except the first "None" option
	while (commitModelInput.children.length > 1) {
		commitModelInput.removeChild(commitModelInput.lastChild);
	}

	// Filter models that support commit generation (openai, openai-responses, anthropic, ollama apiMode)
	const commitCompatibleModels = state.models
		.filter((model) => {
			const apiMode = model.apiMode || "openai";
			const providerEnabled = !state.disabledProviders.some(
				(provider) => provider.toLowerCase() === model.owned_by.toLowerCase()
			);
			// Commit generation still uses API-key based providers; it has no subscription OAuth transport.
			return (
				!model.chatgptAuth &&
				apiMode !== "gemini" &&
				model.enabled !== false &&
				providerEnabled &&
				!model.id.startsWith("__provider__")
			);
		})
		.sort((a, b) => a.id.localeCompare(b.id));

	// Add options for compatible models
	commitCompatibleModels.forEach((model) => {
		const option = document.createElement("option");
		const fullModelId = `${model.id}${model.configId ? "::" + model.configId : ""}`;
		option.value = fullModelId;
		option.textContent = model.displayName || fullModelId;
		commitModelInput.appendChild(option);
	});
}

// Dropdown visibility functions
function showDropdown() {
	if (dropdownContent.children.length > 0) {
		modelIdDropdown.classList.add("show");
	}
}

function hideDropdown() {
	modelIdDropdown.classList.remove("show");
}

function toggleDropdown() {
	if (modelIdDropdown.classList.contains("show")) {
		hideDropdown();
	} else {
		showDropdown();
	}
}

// Populate model form with existing data
function populateModelForm(model) {
	// Clear any error message
	showModelError("");

	// Store the original modelId and configId for update operations
	modelIdInput.setAttribute("data-original-id", model.id || "");
	modelIdInput.setAttribute("data-original-configId", model.configId || "");

	modelIdInput.value = model.id || "";

	// Ensure the provider is in the dropdown options
	const currentProvider = model.owned_by || "";
	const providerExists = Array.from(modelProviderInput.options).some((option) => option.value === currentProvider);

	if (!providerExists && currentProvider) {
		// Add the provider to the dropdown if it doesn't exist
		const newOption = document.createElement("option");
		newOption.value = currentProvider;
		newOption.textContent = currentProvider;
		modelProviderInput.appendChild(newOption);
	}

	const providerInfo = state.providerInfo[currentProvider];
	const fetchBaseUrl = model.baseUrl || state.baseUrl;
	const fetchApiKey = state.providerKeys[currentProvider] || state.apiKey;
	const fetchApiMode = providerInfo?.apiMode || model.apiMode || modelApiModeInput.value || "openai";

	// Subscription model metadata is already available; never fetch it via a generic API key.
	if (model.chatgptAuth) {
		populateModelIdDropdown(state.discoveredModels);
	} else {
		vscode.postMessage({
			type: "fetchModels",
			baseUrl: fetchBaseUrl,
			apiKey: fetchApiKey,
			apiMode: fetchApiMode,
			headers: model.headers,
		});
	}

	modelProviderInput.value = currentProvider;
	modelEnabledInput.checked = model.enabled !== false;
	modelDisplayNameInput.value = model.displayName || "";
	modelConfigIdInput.value = model.configId || "";
	modelBaseUrlInput.value = model.baseUrl || "";
	modelFamilyInput.value = model.family || "";
	modelContextLengthInput.value = model.context_length || "";
	modelMaxTokensInput.value = model.max_tokens || "";
	modelPriceInputInput.value = model.pricing?.input !== undefined ? model.pricing.input : "";
	modelPriceOutputInput.value = model.pricing?.output !== undefined ? model.pricing.output : "";
	modelPriceCacheReadInput.value = model.pricing?.cache_read !== undefined ? model.pricing.cache_read : "";
	modelPriceCacheWriteInput.value = model.pricing?.cache_write !== undefined ? model.pricing.cache_write : "";
	modelVisionInput.value = model.vision !== undefined ? String(model.vision) : "";
	modelApiModeInput.value = model.apiMode || (model.chatgptAuth ? "openai-responses" : "openai");
	modelChatGPTAuthInput.checked = model.chatgptAuth === true;
	modelChatGPTAuthInput.disabled = isDiscoveredChatGPTModel(model);
	modelProviderInput.disabled = isDiscoveredChatGPTModel(model);
	modelConfigIdInput.disabled = isDiscoveredChatGPTModel(model);
	modelTemperatureInput.value = model.temperature !== undefined && model.temperature !== null ? model.temperature : "";
	modelTopPInput.value = model.top_p !== undefined && model.top_p !== null ? model.top_p : "";
	modelDelayInput.value = model.delay || "";
	modelTopKInput.value = model.top_k || "";
	modelMinPInput.value = model.min_p || "";
	modelFrequencyPenaltyInput.value = model.frequency_penalty || "";
	modelPresencePenaltyInput.value = model.presence_penalty || "";
	modelRepetitionPenaltyInput.value = model.repetition_penalty || "";
	if (model.chatgptAuth && model.reasoning_efforts?.length) {
		modelReasoningEffortInput.replaceChildren(new Option("Default", ""));
		for (const level of model.reasoning_efforts) {
			modelReasoningEffortInput.add(
				new Option(level.effort + (level.description ? " — " + level.description : ""), level.effort)
			);
		}
	}
	modelReasoningEffortInput.value = model.reasoning_effort || "";
	modelEnableThinkingInput.value = model.enable_thinking !== undefined ? String(model.enable_thinking) : "";
	modelThinkingBudgetInput.value = model.thinking_budget || "";
	modelIncludeReasoningInput.value =
		model.include_reasoning_in_request !== undefined ? String(model.include_reasoning_in_request) : "";
	modelMaxCompletionTokensInput.value = model.max_completion_tokens || "";
	// Populate reasoning configuration
	if (model.reasoning) {
		modelReasoningEnabledInput.value = model.reasoning.enabled !== undefined ? String(model.reasoning.enabled) : "";
		modelReasoningEffortORInput.value = model.reasoning.effort || "";
		modelReasoningExcludeInput.value = model.reasoning.exclude !== undefined ? String(model.reasoning.exclude) : "";
		modelReasoningMaxTokensInput.value = model.reasoning.max_tokens || "";
	}
	// Populate thinking configuration
	if (model.thinking) {
		modelThinkingTypeInput.value = model.thinking.type || "";
	}
	// Populate headers and extra
	modelHeadersInput.value = model.headers ? JSON.stringify(model.headers, null, 2) : "";
	modelExtraInput.value = model.extra ? JSON.stringify(model.extra, null, 2) : "";
	// Mark that we're in editing mode by setting an attribute
	modelIdInput.setAttribute("data-editing", "true");
	// Disable BaseURL and apiMode fields when editing
	modelBaseUrlInput.disabled = true;
	modelApiModeInput.disabled = true;
}

// Initialize dropdown event listeners
function initDropdownEvents() {
	// Show dropdown on focus
	modelIdInput.addEventListener("focus", () => {
		if (dropdownContent.children.length > 0) {
			showDropdown();
		}
	});

	// Hide dropdown when clicking outside
	document.addEventListener("click", (event) => {
		if (!modelIdDropdown.contains(event.target) && event.target !== modelIdInput) {
			hideDropdown();
		}
	});

	// Handle keyboard navigation
	modelIdInput.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			hideDropdown();
		} else if (event.key === "ArrowDown" && modelIdDropdown.classList.contains("show")) {
			event.preventDefault();
			const options = dropdownContent.querySelectorAll(".dropdown-option");
			if (options.length > 0) {
				const firstOption = options[0];
				firstOption.focus();
				firstOption.classList.add("selected");
			}
		}
	});

	// Allow user to type freely
	modelIdInput.addEventListener("input", () => {
		// Clear selection when user types
		dropdownContent.querySelectorAll(".dropdown-option").forEach((opt) => {
			opt.classList.remove("selected");
		});

		// Filter options based on input
		const searchTerm = modelIdInput.value.toLowerCase();
		const options = dropdownContent.querySelectorAll(".dropdown-option");

		options.forEach((option) => {
			const modelId = option.dataset.modelId.toLowerCase();
			if (modelId.includes(searchTerm)) {
				option.style.display = "block";
			} else {
				option.style.display = "none";
			}
		});

		// Update header with filtered count
		const visibleCount = Array.from(options).filter((opt) => opt.style.display !== "none").length;
		dropdownHeader.textContent = `Select Model (${visibleCount} matching)`;
	});
}

// Initialize dropdown events
initDropdownEvents();

vscode.postMessage({ type: "requestInit" });
