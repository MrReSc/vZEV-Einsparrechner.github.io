(function (global) {
  "use strict";

  var FAIRNESS_EPSILON = 0.000001;
  var PRICE_SWEEP_STEP_RP_KWH = 0.1;
  var DEFAULT_STATE = Object.freeze({
    maxProducerCount: 7,
    maxConsumerCount: 10,
    monthlyKwhPerParticipant: 200,
    consumerDaytimeSharePercent: 55,
    totalPvKw: 63,
    pvYieldKwhPerKwYear: 900,
    evuPriceRpKwh: 25.76,
    feedInRpKwh: 8,
    vzevFeeChfMonth: 3,
    virtualMeterChfMonth: 2,
    vatPercent: 8.1,
    producerMinYieldChfYear: 100,
    winterMonths: 3
  });

  function normalizeNumber(value, fallback) {
    var numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
  }

  function sanitizeState(candidate) {
    var input = candidate && typeof candidate === "object" ? candidate : {};
    return {
      maxProducerCount: normalizeNumber(input.maxProducerCount, DEFAULT_STATE.maxProducerCount),
      maxConsumerCount: normalizeNumber(input.maxConsumerCount, DEFAULT_STATE.maxConsumerCount),
      monthlyKwhPerParticipant: normalizeNumber(input.monthlyKwhPerParticipant, DEFAULT_STATE.monthlyKwhPerParticipant),
      consumerDaytimeSharePercent: normalizeNumber(input.consumerDaytimeSharePercent, DEFAULT_STATE.consumerDaytimeSharePercent),
      totalPvKw: normalizeNumber(
        input.totalPvKw,
        normalizeNumber(input.pvKwPerProducer, DEFAULT_STATE.totalPvKw)
      ),
      pvYieldKwhPerKwYear: normalizeNumber(input.pvYieldKwhPerKwYear, DEFAULT_STATE.pvYieldKwhPerKwYear),
      evuPriceRpKwh: normalizeNumber(input.evuPriceRpKwh, DEFAULT_STATE.evuPriceRpKwh),
      feedInRpKwh: normalizeNumber(input.feedInRpKwh, DEFAULT_STATE.feedInRpKwh),
      vzevFeeChfMonth: normalizeNumber(input.vzevFeeChfMonth, DEFAULT_STATE.vzevFeeChfMonth),
      virtualMeterChfMonth: normalizeNumber(input.virtualMeterChfMonth, DEFAULT_STATE.virtualMeterChfMonth),
      vatPercent: normalizeNumber(input.vatPercent, DEFAULT_STATE.vatPercent),
      producerMinYieldChfYear: normalizeNumber(input.producerMinYieldChfYear, DEFAULT_STATE.producerMinYieldChfYear),
      winterMonths: normalizeNumber(input.winterMonths, DEFAULT_STATE.winterMonths)
    };
  }

  function getDefaultMatrixSelection(state) {
    return {
      producerCount: Math.max(1, Math.ceil(state.maxProducerCount / 2)),
      consumerCount: Math.max(1, Math.ceil(state.maxConsumerCount / 2))
    };
  }

  function getVatFactor(state) {
    return 1 + (state.vatPercent / 100);
  }

  function getGrossEvuPriceRpKwh(state) {
    return state.evuPriceRpKwh * getVatFactor(state);
  }

  function calculateScenario(state, producerCount, consumerCount, solarPriceRpKwh) {
    var activeMonths = Math.max(0, 12 - state.winterMonths);
    var feeBreakdown = calculateAnnualFeeBreakdown(state, producerCount, consumerCount);
    var grossEvuPriceRpKwh = getGrossEvuPriceRpKwh(state);
    var daytimeShareFactor = state.consumerDaytimeSharePercent / 100;
    var scenarioTotalPvKw = getScenarioTotalPvKw(state, producerCount);
    var annualPvProductionKwh = scenarioTotalPvKw * state.pvYieldKwhPerKwYear;
    var solarAvailableKwhYear = annualPvProductionKwh * (activeMonths / 12);
    var producerDirectUseKwhYear = Math.min(
      solarAvailableKwhYear,
      producerCount * state.monthlyKwhPerParticipant * 12 * daytimeShareFactor
    );
    var sharedSolarAvailableKwhYear = Math.max(0, solarAvailableKwhYear - producerDirectUseKwhYear);
    var consumerDemandSolarMonthsKwhYear =
      consumerCount * state.monthlyKwhPerParticipant * activeMonths * daytimeShareFactor;
    var localSolarKwhYear = Math.min(sharedSolarAvailableKwhYear, consumerDemandSolarMonthsKwhYear);
    var localSolarKwhPerConsumer = consumerCount > 0 ? localSolarKwhYear / consumerCount : 0;
    var localSolarKwhPerProducer = producerCount > 0 ? localSolarKwhYear / producerCount : 0;
    var consumerDeltaChfYear =
      localSolarKwhPerConsumer * ((grossEvuPriceRpKwh - solarPriceRpKwh) / 100) - feeBreakdown.annualConsumerFeeChf;
    var producerDeltaChfYear =
      localSolarKwhPerProducer * ((solarPriceRpKwh - state.feedInRpKwh) / 100) - feeBreakdown.annualProducerFeeChf;
    var utilizationRatio = sharedSolarAvailableKwhYear > 0 ? localSolarKwhYear / sharedSolarAvailableKwhYear : 0;
    var benefitGapChfYear = consumerDeltaChfYear - producerDeltaChfYear;

    return {
      producerCount: producerCount,
      consumerCount: consumerCount,
      solarPriceRpKwh: solarPriceRpKwh,
      localSolarKwhYear: localSolarKwhYear,
      consumerDeltaChfYear: consumerDeltaChfYear,
      producerDeltaChfYear: producerDeltaChfYear,
      annualConsumerFeeChf: feeBreakdown.annualConsumerFeeChf,
      annualProducerFeeChf: feeBreakdown.annualProducerFeeChf,
      scenarioTotalPvKw: scenarioTotalPvKw,
      annualPvProductionKwh: annualPvProductionKwh,
      producerDirectUseKwhYear: producerDirectUseKwhYear,
      sharedSolarAvailableKwhYear: sharedSolarAvailableKwhYear,
      solarAvailableKwhYear: solarAvailableKwhYear,
      consumerDemandSolarMonthsKwhYear: consumerDemandSolarMonthsKwhYear,
      utilizationRatio: utilizationRatio,
      benefitGapChfYear: benefitGapChfYear,
      isFair: isPositiveMinimumResult({
        benefitGapChfYear: benefitGapChfYear,
        consumerDeltaChfYear: consumerDeltaChfYear,
        producerDeltaChfYear: producerDeltaChfYear
      })
    };
  }

  function calculateSimulation(state) {
    var sweepBounds = getPriceSweepBounds(state);
    var pricePoints = createPriceSweep(sweepBounds.minRpKwh, sweepBounds.maxRpKwh, PRICE_SWEEP_STEP_RP_KWH);
    var summaryMap = {};

    for (var consumerCount = 1; consumerCount <= state.maxConsumerCount; consumerCount += 1) {
      for (var producerCount = 1; producerCount <= state.maxProducerCount; producerCount += 1) {
        var priceResults = pricePoints.map(function (solarPriceRpKwh) {
          return calculateScenario(state, producerCount, consumerCount, solarPriceRpKwh);
        });
        var balancePriceRpKwh = calculateBalancePrice(state, producerCount, consumerCount);
        var balanceResult = balancePriceRpKwh === null
          ? priceResults[0]
          : calculateScenario(state, producerCount, consumerCount, balancePriceRpKwh);
        var hasFairScenario =
          balancePriceRpKwh !== null &&
          isPositiveMinimumResult(balanceResult);
        var minimumPriceRpKwh = hasFairScenario ? balanceResult.solarPriceRpKwh : null;
        var recommendedBand = calculateRecommendedPriceBand(state, minimumPriceRpKwh);
        var optimalResult = hasFairScenario ? balanceResult : null;
        var closestResult = getClosestResult(priceResults, balancePriceRpKwh);
        var recommendedResult = getRecommendedResult(
          priceResults,
          recommendedBand.minRpKwh,
          recommendedBand.maxRpKwh,
          state.producerMinYieldChfYear
        );
        var hasRecommendedBand =
          recommendedBand.minRpKwh !== null &&
          recommendedBand.maxRpKwh !== null &&
          recommendedBand.maxRpKwh > recommendedBand.minRpKwh + FAIRNESS_EPSILON;
        var detailRecommendedResult = recommendedResult || (
          hasFairScenario
            ? getClosestProducerYieldResult(
                priceResults,
                state.producerMinYieldChfYear,
                minimumPriceRpKwh,
                hasRecommendedBand ? recommendedBand.maxRpKwh : null
              )
            : null
        );
        var referenceResult = priceResults[0];

        summaryMap[getScenarioKey(producerCount, consumerCount)] = {
          producerCount: producerCount,
          consumerCount: consumerCount,
          optimalPriceRpKwh: optimalResult ? optimalResult.solarPriceRpKwh : null,
          hasFairScenario: hasFairScenario,
          status: getScenarioStatus(
            recommendedResult ? recommendedResult.solarPriceRpKwh : null,
            hasFairScenario ? minimumPriceRpKwh : null
          ),
          priceResults: priceResults,
          optimalResult: optimalResult,
          closestResult: closestResult,
          recommendedResult: recommendedResult,
          detailRecommendedResult: detailRecommendedResult,
          balanceResult: balanceResult,
          minimumPriceRpKwh: minimumPriceRpKwh,
          recommendedBandMinRpKwh: recommendedBand.minRpKwh,
          recommendedBandMaxRpKwh: recommendedBand.maxRpKwh,
          recommendedPriceRpKwh: recommendedResult ? recommendedResult.solarPriceRpKwh : null,
          detailRecommendedPriceRpKwh: detailRecommendedResult ? detailRecommendedResult.solarPriceRpKwh : null,
          localSolarKwhYear: referenceResult ? referenceResult.localSolarKwhYear : 0,
          sharedSolarAvailableKwhYear: referenceResult ? referenceResult.sharedSolarAvailableKwhYear : 0,
          annualPvProductionKwh: referenceResult ? referenceResult.annualPvProductionKwh : 0,
          solarAvailableKwhYear: referenceResult ? referenceResult.solarAvailableKwhYear : 0,
          consumerDemandSolarMonthsKwhYear: referenceResult ? referenceResult.consumerDemandSolarMonthsKwhYear : 0
        };
      }
    }

    return {
      pricePoints: pricePoints,
      summaryMap: summaryMap
    };
  }

  function isPositiveMinimumResult(result) {
    return (
      Math.abs(result.benefitGapChfYear) <= FAIRNESS_EPSILON &&
      result.consumerDeltaChfYear > FAIRNESS_EPSILON &&
      result.producerDeltaChfYear > FAIRNESS_EPSILON
    );
  }

  function calculateBalancePrice(state, producerCount, consumerCount) {
    var activeMonths = Math.max(0, 12 - state.winterMonths);
    var feeBreakdown = calculateAnnualFeeBreakdown(state, producerCount, consumerCount);
    var grossEvuPriceRpKwh = getGrossEvuPriceRpKwh(state);
    var daytimeShareFactor = state.consumerDaytimeSharePercent / 100;
    var scenarioTotalPvKw = getScenarioTotalPvKw(state, producerCount);
    var annualPvProductionKwh = scenarioTotalPvKw * state.pvYieldKwhPerKwYear;
    var solarAvailableKwhYear = annualPvProductionKwh * (activeMonths / 12);
    var producerDirectUseKwhYear = Math.min(
      solarAvailableKwhYear,
      producerCount * state.monthlyKwhPerParticipant * 12 * daytimeShareFactor
    );
    var sharedSolarAvailableKwhYear = Math.max(0, solarAvailableKwhYear - producerDirectUseKwhYear);
    var consumerDemandSolarMonthsKwhYear =
      consumerCount * state.monthlyKwhPerParticipant * activeMonths * daytimeShareFactor;
    var localSolarKwhYear = Math.min(sharedSolarAvailableKwhYear, consumerDemandSolarMonthsKwhYear);
    var localSolarKwhPerConsumer = consumerCount > 0 ? localSolarKwhYear / consumerCount : 0;
    var localSolarKwhPerProducer = producerCount > 0 ? localSolarKwhYear / producerCount : 0;
    var denominator = localSolarKwhPerConsumer + localSolarKwhPerProducer;

    if (denominator <= FAIRNESS_EPSILON) {
      return null;
    }

    return (
      localSolarKwhPerConsumer * grossEvuPriceRpKwh +
      localSolarKwhPerProducer * state.feedInRpKwh +
      100 * (feeBreakdown.annualProducerFeeChf - feeBreakdown.annualConsumerFeeChf)
    ) / denominator;
  }

  function getScenarioTotalPvKw(state, producerCount) {
    if (state.maxProducerCount <= 0) {
      return 0;
    }

    return state.totalPvKw * (producerCount / state.maxProducerCount);
  }

  function calculateRecommendedPriceBand(state, minimumPriceRpKwh) {
    if (minimumPriceRpKwh === null || !Number.isFinite(minimumPriceRpKwh)) {
      return { minRpKwh: null, maxRpKwh: null };
    }

    return {
      minRpKwh: minimumPriceRpKwh,
      maxRpKwh: getGrossEvuPriceRpKwh(state) * 0.8
    };
  }

  function getRecommendedResult(priceResults, minRpKwh, maxRpKwh, producerMinYieldChfYear) {
    if (!priceResults.length || minRpKwh === null || maxRpKwh === null || maxRpKwh <= minRpKwh + FAIRNESS_EPSILON) {
      return null;
    }

    for (var i = 0; i < priceResults.length; i += 1) {
      var result = priceResults[i];
      if (
        result.solarPriceRpKwh >= minRpKwh - FAIRNESS_EPSILON &&
        result.solarPriceRpKwh <= maxRpKwh + FAIRNESS_EPSILON &&
        result.producerDeltaChfYear >= producerMinYieldChfYear - FAIRNESS_EPSILON
      ) {
        return result;
      }
    }

    return null;
  }

  function getClosestProducerYieldResult(priceResults, producerMinYieldChfYear, minRpKwh, maxRpKwh) {
    if (!priceResults.length) {
      return null;
    }

    var bestResult = null;
    var bestDistance = Infinity;

    for (var i = 0; i < priceResults.length; i += 1) {
      var result = priceResults[i];
      if (result.consumerDeltaChfYear < -FAIRNESS_EPSILON) {
        continue;
      }
      if (minRpKwh !== null && result.solarPriceRpKwh < minRpKwh - FAIRNESS_EPSILON) {
        continue;
      }
      if (maxRpKwh !== null && result.solarPriceRpKwh > maxRpKwh + FAIRNESS_EPSILON) {
        continue;
      }

      var distance = Math.abs(result.producerDeltaChfYear - producerMinYieldChfYear);
      if (distance < bestDistance - FAIRNESS_EPSILON) {
        bestResult = result;
        bestDistance = distance;
      }
    }

    return bestResult;
  }

  function calculateAnnualFeeBreakdown(state, producerCount, consumerCount) {
    var totalParticipants = producerCount + consumerCount;
    var annualParticipantFeeNetChf = state.vzevFeeChfMonth * 12;
    var annualVirtualMeterShareNetChf =
      totalParticipants > 0 ? (state.virtualMeterChfMonth * 12) / totalParticipants : 0;
    var annualConsumerFeeNetChf = annualParticipantFeeNetChf + annualVirtualMeterShareNetChf;
    var annualProducerFeeNetChf = annualParticipantFeeNetChf + annualVirtualMeterShareNetChf;
    var vatFactor = getVatFactor(state);

    return {
      totalParticipants: totalParticipants,
      producerCount: producerCount,
      vatFactor: vatFactor,
      annualParticipantFeeNetChf: annualParticipantFeeNetChf,
      annualVirtualMeterShareNetChf: annualVirtualMeterShareNetChf,
      annualConsumerFeeNetChf: annualConsumerFeeNetChf,
      annualProducerFeeNetChf: annualProducerFeeNetChf,
      annualConsumerFeeChf: annualConsumerFeeNetChf * vatFactor,
      annualProducerFeeChf: annualProducerFeeNetChf * vatFactor
    };
  }

  function createPriceSweep(minValue, maxValue, stepValue) {
    var scale = Math.pow(10, Math.max(getDecimalPlaces(minValue), getDecimalPlaces(maxValue), getDecimalPlaces(stepValue)));
    var minUnits = Math.round(minValue * scale);
    var maxUnits = Math.round(maxValue * scale);
    var stepUnits = Math.max(1, Math.round(stepValue * scale));
    var values = [];

    for (var current = minUnits; current <= maxUnits; current += stepUnits) {
      values.push(current / scale);
    }

    if (values.length === 0 || Math.abs(values[values.length - 1] - maxValue) > (1 / scale) / 2) {
      values.push(maxValue);
    }

    return values;
  }

  function getPriceSweepBounds(state) {
    var grossEvuPriceRpKwh = getGrossEvuPriceRpKwh(state);
    return {
      minRpKwh: Math.min(state.feedInRpKwh, grossEvuPriceRpKwh),
      maxRpKwh: Math.max(state.feedInRpKwh, grossEvuPriceRpKwh)
    };
  }

  function getDecimalPlaces(value) {
    var valueString = String(value);
    var separatorIndex = valueString.indexOf(".");
    return separatorIndex === -1 ? 0 : valueString.length - separatorIndex - 1;
  }

  function getClosestResult(priceResults, targetPriceRpKwh) {
    if (!priceResults.length) {
      return null;
    }

    var bestResult = priceResults[0];
    var bestDistance = Math.abs(priceResults[0].solarPriceRpKwh - targetPriceRpKwh);

    for (var i = 1; i < priceResults.length; i += 1) {
      var result = priceResults[i];
      var distance = Math.abs(result.solarPriceRpKwh - targetPriceRpKwh);
      if (distance < bestDistance - FAIRNESS_EPSILON) {
        bestResult = result;
        bestDistance = distance;
      }
    }

    return bestResult;
  }

  function getScenarioStatus(recommendedPriceRpKwh, minimumPriceRpKwh) {
    if (recommendedPriceRpKwh !== null && Number.isFinite(recommendedPriceRpKwh)) {
      return "fair";
    }

    if (minimumPriceRpKwh !== null && Number.isFinite(minimumPriceRpKwh)) {
      return "critical";
    }

    return "not_fair";
  }

  function getScenarioKey(producerCount, consumerCount) {
    return String(producerCount) + ":" + String(consumerCount);
  }

  global.VzevSimulationCore = Object.freeze({
    DEFAULT_STATE: DEFAULT_STATE,
    FAIRNESS_EPSILON: FAIRNESS_EPSILON,
    PRICE_SWEEP_STEP_RP_KWH: PRICE_SWEEP_STEP_RP_KWH,
    calculateAnnualFeeBreakdown: calculateAnnualFeeBreakdown,
    calculateBalancePrice: calculateBalancePrice,
    calculateRecommendedPriceBand: calculateRecommendedPriceBand,
    calculateScenario: calculateScenario,
    calculateSimulation: calculateSimulation,
    createPriceSweep: createPriceSweep,
    getClosestProducerYieldResult: getClosestProducerYieldResult,
    getClosestResult: getClosestResult,
    getDefaultMatrixSelection: getDefaultMatrixSelection,
    getGrossEvuPriceRpKwh: getGrossEvuPriceRpKwh,
    getPriceSweepBounds: getPriceSweepBounds,
    getRecommendedResult: getRecommendedResult,
    getScenarioKey: getScenarioKey,
    getScenarioStatus: getScenarioStatus,
    getScenarioTotalPvKw: getScenarioTotalPvKw,
    getVatFactor: getVatFactor,
    isPositiveMinimumResult: isPositiveMinimumResult,
    sanitizeState: sanitizeState
  });
})(typeof window !== "undefined" ? window : globalThis);
