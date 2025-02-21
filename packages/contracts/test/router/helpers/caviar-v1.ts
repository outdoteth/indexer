import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, BigNumberish, Contract, constants } from "ethers";
import * as Sdk from "@reservoir0x/sdk/src";
import { getChainId, getRandomInteger } from "../../utils";
import CaviarFactoryAbi from "@reservoir0x/sdk/src/caviar-v1/abi/caviar.abi.json";
import CaviarPoolAbi from "@reservoir0x/sdk/src/caviar-v1/abi/public-pool.abi.json";
import { ethers } from "hardhat";
import { parseEther } from "ethers/lib/utils";

export type CaviarListing = {
  seller: SignerWithAddress;
  nft: {
    contract: Contract;
    id: number;
  };
  price: BigNumberish;
  // Whether the order is to be cancelled
  isCancelled?: boolean;
  order?: Sdk.CaviarV1.Order;
};

export const setupCaviarListings = async (listings: CaviarListing[]) => {
  const chainId = getChainId();

  const factory = new Contract(
    Sdk.CaviarV1.Addresses.CaviarFactoryContract[chainId],
    CaviarFactoryAbi,
    ethers.provider
  );

  for (const listing of listings) {
    const { seller, nft, price, isCancelled } = listing;

    // Get the pair address by making a static call to the deploy method
    const pool = await factory
      .connect(seller)
      .callStatic.create(nft.contract.address, constants.AddressZero, constants.HashZero);

    // Actually deploy the pool
    await factory
      .connect(seller)
      .create(nft.contract.address, constants.AddressZero, constants.HashZero);

    // Approve the pool contract
    const secondNftId = getRandomInteger(1, 10000);
    const thirdNftId = getRandomInteger(1, 10000);
    await nft.contract.connect(seller).mint(secondNftId);
    await nft.contract.connect(seller).mint(thirdNftId);
    await nft.contract.connect(seller).mint(nft.id);
    await nft.contract.connect(seller).setApprovalForAll(pool, true);

    // disable stolen NFT filtering
    const caviarAdmin = await ethers.getImpersonatedSigner(
      "0x6E1696C2f1Ab89f9C2f8275fC48C8D5BE9522180"
    );
    await factory.connect(caviarAdmin).setStolenNftFilterOracle(constants.AddressZero);

    const poolContract = new Contract(pool, CaviarPoolAbi, ethers.provider);
    const baseTokenAmount = BigNumber.from(price).mul("2");
    await poolContract
      .connect(seller)
      .nftAdd(
        baseTokenAmount,
        isCancelled ? [secondNftId, thirdNftId] : [nft.id, secondNftId],
        0,
        0,
        constants.MaxUint256,
        0,
        [],
        [],
        {
          value: baseTokenAmount,
        }
      );

    const inputAmount = await poolContract.buyQuote(parseEther("1"));

    listing.order = new Sdk.CaviarV1.Order(chainId, {
      pool,
      extra: {
        prices: [inputAmount.toString()],
      },
    });
  }
};

export type CaviarOffer = {
  buyer: SignerWithAddress;
  nft: {
    contract: Contract;
    id: number;
  };
  price: BigNumberish;
  isCancelled?: boolean;
  order?: Sdk.CaviarV1.Order;
};

export const setupCaviarOffers = async (offers: CaviarOffer[]) => {
  const chainId = getChainId();

  const factory = new Contract(
    Sdk.CaviarV1.Addresses.CaviarFactoryContract[chainId],
    CaviarFactoryAbi,
    ethers.provider
  );

  for (const offer of offers) {
    const { buyer, nft, price, isCancelled } = offer;

    // Get the pair address by making a static call to the deploy method
    const pool = await factory
      .connect(buyer)
      .callStatic.create(nft.contract.address, constants.AddressZero, constants.HashZero);

    // Actually deploy the pool
    await factory
      .connect(buyer)
      .create(nft.contract.address, constants.AddressZero, constants.HashZero);

    // Approve the pool contract
    const nftId = getRandomInteger(1, 10000);
    await nft.contract.connect(buyer).mint(nftId);
    await nft.contract.connect(buyer).setApprovalForAll(pool, true);

    // disable stolen NFT filtering
    const caviarAdmin = await ethers.getImpersonatedSigner(
      "0x6E1696C2f1Ab89f9C2f8275fC48C8D5BE9522180"
    );
    await factory.connect(caviarAdmin).setStolenNftFilterOracle(constants.AddressZero);

    // deposit liquidity
    const poolContract = new Contract(pool, CaviarPoolAbi, ethers.provider);
    const baseTokenAmount = BigNumber.from(price);

    if (!isCancelled) {
      await poolContract
        .connect(buyer)
        .nftAdd(baseTokenAmount, [nftId], 0, 0, constants.MaxUint256, 0, [], [], {
          value: baseTokenAmount,
        });
    }

    const outputAmount = await poolContract.sellQuote(parseEther("1"));

    offer.order = new Sdk.CaviarV1.Order(chainId, {
      pool,
      extra: {
        prices: [isCancelled ? price.toString() : outputAmount.toString()],
      },
    });
  }
};
